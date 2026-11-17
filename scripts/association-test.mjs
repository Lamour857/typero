import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const edgeCandidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];
const executablePath = edgeCandidates.find(existsSync);
if (!executablePath) {
  console.error("Microsoft Edge was not found. Install Edge or update this test.");
  process.exit(1);
}

const testRoot = path.join(os.tmpdir(), `typero-association-test-${process.pid}`);
const runtimeDir = path.join(testRoot, "runtime");
const markdownPath = path.join(testRoot, "关联 打开 测试.md");
const port = await findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
let browser = null;
let secret = null;
let serverPid = null;
let serverStarted = false;

try {
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    markdownPath,
    "# 关联打开测试\n\n这是通过文件关联打开的原始内容。\n",
    "utf8"
  );

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      path.join(root, "scripts", "launch.mjs"),
      "--file",
      markdownPath,
      "--no-open",
      "--port",
      String(port),
      "--runtime",
      runtimeDir
    ],
    { cwd: root, timeout: 25000 }
  );

  const urlMatch = stdout.match(/Typero:\s*(http:\/\/\S+)/);
  assert.ok(urlMatch, `launcher should print an app URL, got: ${stdout}`);
  const appUrl = urlMatch[1];
  assert.match(appUrl, /\?open=/);

  await waitForServer(baseUrl);
  serverStarted = true;
  secret = (await readFile(path.join(runtimeDir, "secret"), "utf8")).trim();
  serverPid = JSON.parse(await readFile(path.join(runtimeDir, "server.json"), "utf8")).pid;

  const unauthorized = await fetch(`${baseUrl}/api/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ noOpen: true })
  });
  assert.equal(unauthorized.status, 403, "open API must require the launcher secret");

  browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({
    viewport: { width: 1200, height: 880 },
    colorScheme: "dark"
  });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("dialog", (dialog) => dialog.accept());

  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.locator("#preview h1").first().waitFor();

  assert.equal(await page.locator("#fileName").textContent(), "关联 打开 测试.md");
  assert.match(await page.locator("#editor").inputValue(), /通过文件关联打开的原始内容/);
  assert.equal(await page.locator("#saveStatus").textContent(), "已保存到文件");
  assert.match(await page.locator("#fileCard").getAttribute("title"), /关联 打开 测试\.md$/);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("typero.draft")),
    null,
    "a linked document must not touch the normal local draft"
  );

  const edited = "# 关联打开测试\n\n这是已经修改并保存的内容。\n";
  await page.locator("#editor").fill(edited);
  await page.waitForTimeout(1100);

  const draftState = await page.evaluate(() => ({
    sessionKeys: Object.keys(sessionStorage).filter((key) =>
      key.startsWith("typero.draft.session.")
    ),
    localDraft: localStorage.getItem("typero.draft")
  }));
  assert.equal(draftState.sessionKeys.length, 1, "linked edits should use a session-scoped draft");
  assert.equal(draftState.localDraft, null, "linked edits must not write the global draft");

  await page.click("#saveBtn");
  await page.waitForTimeout(500);
  assert.equal(await page.locator("#saveStatus").textContent(), "已保存到文件");
  assert.equal(await readFile(markdownPath, "utf8"), edited);
  assert.equal(
    await page.evaluate(
      () =>
        Object.keys(sessionStorage).filter((key) => key.startsWith("typero.draft.session."))
          .length
    ),
    0,
    "saving should clear the session draft"
  );

  const unsavedReload = `${edited}\n## 刷新后仍应保留\n\n这段内容尚未保存。\n`;
  await page.locator("#editor").fill(unsavedReload);
  await page.waitForTimeout(1100);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#preview h1").first().waitFor();
  assert.match(
    await page.locator("#editor").inputValue(),
    /刷新后仍应保留/,
    "session draft should survive a reload"
  );
  assert.equal(
    await page.evaluate(() =>
      document.querySelector("#saveIndicator").classList.contains("is-dirty")
    ),
    true
  );
  assert.equal(await page.locator("#saveStatus").textContent(), "未保存 · 关闭前请保存");

  assert.deepEqual(errors, [], "association flow should produce no browser errors");
  console.log("Association test passed.");
} finally {
  if (browser) await browser.close();
  if (serverStarted && secret) {
    try {
      await fetch(`${baseUrl}/api/shutdown`, {
        method: "POST",
        headers: { "X-Typero-Secret": secret },
        signal: AbortSignal.timeout(3000)
      });
    } catch {
      /* Fall through to process cleanup. */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      const response = await fetch(`${baseUrl}/api/ping`, {
        signal: AbortSignal.timeout(500)
      });
      if (response.ok && serverPid) process.kill(serverPid);
    } catch {
      /* The service has exited as expected. */
    }
  }
  await rm(testRoot, { recursive: true, force: true });
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/ping`);
      if (response.ok) return;
    } catch {
      /* still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Typero service did not start at ${url}`);
}
