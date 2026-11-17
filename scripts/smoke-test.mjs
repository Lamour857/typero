import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const edgeCandidates = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
];
const executablePath = edgeCandidates.find(existsSync);
if (!executablePath) {
  console.error("Microsoft Edge was not found. Install Edge or update this test.");
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const screenshotDir = process.env.TYPERO_SHOTS || os.tmpdir();
const testRuntimeDir = path.join(os.tmpdir(), `typero-test-runtime-${process.pid}`);
let serverProcess = null;
let baseUrl = process.env.TYPERO_URL;

if (!baseUrl) {
  await mkdir(testRuntimeDir, { recursive: true });
  const port = await findFreePort();
  serverProcess = spawn(
    process.execPath,
    [
      path.join(root, "server.mjs"),
      "--no-open",
      "--port",
      String(port),
      "--runtime",
      testRuntimeDir
    ],
    { cwd: root, stdio: "ignore" }
  );
  baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl);
}

process.on("exit", () => {
  if (serverProcess && !serverProcess.killed) serverProcess.kill();
});

function findFreePort() {
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
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* server is still starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Typero server did not start at ${url}`);
}

const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 980 },
  colorScheme: "dark",
  acceptDownloads: true
});
const page = await context.newPage();
const errors = [];

function watchPage(target, label) {
  target.on("console", (message) => {
    if (message.type() === "error") errors.push(`${label} console: ${message.text()}`);
  });
  target.on("pageerror", (error) => errors.push(`${label} pageerror: ${error.message}`));
}

watchPage(page, "desktop");

await page.goto(`${baseUrl}/?theme=dark`, { waitUntil: "networkidle" });
await page.locator("#preview h1").first().waitFor();

const initial = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  outline: Array.from(document.querySelectorAll(".outline-item")).map((item) => item.textContent),
  emptyVisible: getComputedStyle(document.querySelector("#outlineEmpty")).display !== "none",
  headings: Array.from(document.querySelectorAll("#preview h1, #preview h2")).map((heading) =>
    heading.textContent.replace("#", "").trim()
  ),
  tasks: document.querySelectorAll('#preview input[type="checkbox"]').length,
  katex: document.querySelectorAll("#preview .katex").length,
  codeBlocks: document.querySelectorAll("#preview .code-block").length,
  tables: document.querySelectorAll("#preview .table-wrap").length,
  mode: document.querySelector("#workspace").dataset.mode,
  title: document.title
}));

assert.equal(initial.theme, "dark");
assert.equal(initial.mode, "split");
assert.equal(initial.outline.length, 5, "expected five welcome-document headings in the outline");
assert.equal(initial.emptyVisible, false, "empty outline message should be hidden");
assert.equal(initial.tasks, 4, "expected four task-list checkboxes");
assert.equal(initial.katex, 2, "expected inline and display KaTeX formulas");
assert.equal(initial.codeBlocks, 1, "expected one decorated code block");
assert.equal(initial.tables, 1, "expected one decorated table");
assert.match(initial.title, /Typero/);

await page.screenshot({ path: path.join(screenshotDir, "typero-dark.png"), fullPage: false });

await page.keyboard.press("?");
await page.waitForTimeout(180);
assert.equal(await page.evaluate(() => document.querySelector("#shortcutsDialog").open), true);
await page.screenshot({ path: path.join(screenshotDir, "typero-shortcuts.png"), fullPage: false });
await page.keyboard.press("Escape");
await page.waitForTimeout(100);

await page.click("#themeToggle");
await page.waitForTimeout(420);
assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
await page.screenshot({ path: path.join(screenshotDir, "typero-light.png"), fullPage: false });

await page.click('.mode-btn[data-mode="read"]');
await page.waitForTimeout(150);
assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#previewPane")).display), "flex");
await page.screenshot({ path: path.join(screenshotDir, "typero-read.png"), fullPage: false });

await page.click('.mode-btn[data-mode="source"]');
await page.waitForTimeout(150);
assert.equal(await page.evaluate(() => document.querySelector("#workspace").dataset.mode), "source");
assert.equal(
  await page.evaluate(() => getComputedStyle(document.querySelector("#sourcePane")).display),
  "flex"
);
await page.screenshot({ path: path.join(screenshotDir, "typero-source.png"), fullPage: false });

await page.click('.mode-btn[data-mode="split"]');
await page.locator('#preview input[type="checkbox"]').first().click();
await page.waitForTimeout(180);
const taskEdited = await page.locator("#editor").inputValue();
assert.match(taskEdited, /- \[ \] 明暗两套主题/, "task checkbox should sync back to Markdown");

await page.locator("#editor").fill(`${taskEdited}\n\n## 新增标题\n\n这是一段测试内容。`);
await page.waitForTimeout(220);
assert.equal(
  await page.locator(".outline-item", { hasText: "新增标题" }).count(),
  1,
  "new heading should appear in outline"
);
assert.equal(
  await page.locator("#preview h2", { hasText: "新增标题" }).count(),
  1,
  "new heading should render in preview"
);

await page.evaluate(() => {
  window.__savedText = "";
  window.showSaveFilePicker = async () => ({
    name: "typero-smoke-test.md",
    createWritable: async () => ({
      write: async (value) => {
        window.__savedText = String(value);
      },
      close: async () => {}
    })
  });
});
await page.click("#saveBtn");
await page.waitForTimeout(300);
const saveResult = await page.evaluate(() => ({
  text: window.__savedText,
  status: document.querySelector("#saveStatus").textContent,
  fileName: document.querySelector("#fileName").textContent,
  dirty: document.querySelector("#saveIndicator").classList.contains("is-dirty")
}));
assert.match(saveResult.text, /新增标题/);
assert.equal(saveResult.status, "已保存到文件");
assert.equal(saveResult.fileName, "typero-smoke-test.md");
assert.equal(saveResult.dirty, false);

const downloadPromise = page.waitForEvent("download");
await page.click("#moreBtn");
await page.click('[data-action="export"]');
const download = await downloadPromise;
assert.equal(download.suggestedFilename(), "typero-smoke-test.html");
const exportedHtml = await readFile(await download.path(), "utf8");
assert.match(exportedHtml, /<!DOCTYPE html>/);
assert.match(exportedHtml, /新增标题/);
assert.match(exportedHtml, /Typero/);

await page.evaluate(() => {
  window.showOpenFilePicker = async () => [
    {
      name: "opened-note.md",
      getFile: async () =>
        new File(["# 打开的文件\n\n来自测试的文件内容。"], "opened-note.md", {
          type: "text/markdown",
          lastModified: Date.now()
        }),
      createWritable: async () => ({ write: async () => {}, close: async () => {} })
    }
  ];
});
await page.click("#openBtn");
await page.waitForTimeout(250);
assert.equal(await page.locator("#fileName").textContent(), "opened-note.md");
assert.match(await page.locator("#editor").inputValue(), /来自测试的文件内容/);
assert.equal(await page.locator('#preview h1', { hasText: "打开的文件" }).count(), 1);

await page.click("#collapseSidebar");
assert.equal(await page.evaluate(() => document.querySelector("#app").classList.contains("is-sidebar-collapsed")), true);
await page.click("#openSidebar");
assert.equal(await page.evaluate(() => document.querySelector("#app").classList.contains("is-sidebar-collapsed")), false);

await page.keyboard.press("F8");
await page.waitForTimeout(180);
assert.equal(await page.evaluate(() => document.querySelector("#app").classList.contains("is-focus")), true);
await page.screenshot({ path: path.join(screenshotDir, "typero-focus.png"), fullPage: false });
await page.keyboard.press("Escape");
await page.waitForTimeout(120);
assert.equal(await page.evaluate(() => document.querySelector("#app").classList.contains("is-focus")), false);

const mobileContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  colorScheme: "dark"
});
const mobilePage = await mobileContext.newPage();
watchPage(mobilePage, "mobile");
await mobilePage.goto(`${baseUrl}/?theme=dark`, { waitUntil: "networkidle" });
await mobilePage.locator("#preview h1").first().waitFor();
assert.equal(
  await mobilePage.evaluate(() => document.querySelector("#app").classList.contains("is-sidebar-collapsed")),
  true,
  "sidebar should start collapsed on a phone-sized viewport"
);
assert.equal(
  await mobilePage.evaluate(() => document.querySelector("#workspace").dataset.mode),
  "read",
  "a fresh phone-sized viewport should default to reading mode"
);
assert.equal(await mobilePage.locator("#themeToggle").isVisible(), true, "theme toggle should remain reachable on mobile");
await mobilePage.screenshot({ path: path.join(screenshotDir, "typero-mobile.png"), fullPage: false });
await mobilePage.click("#openSidebar");
await mobilePage.waitForTimeout(220);
assert.equal(
  await mobilePage.evaluate(() => getComputedStyle(document.querySelector("#sidebarBackdrop")).display),
  "block"
);
await mobilePage.screenshot({ path: path.join(screenshotDir, "typero-mobile-sidebar.png"), fullPage: false });
await mobileContext.close();

const draftContext = await browser.newContext({
  viewport: { width: 1200, height: 860 },
  colorScheme: "dark"
});
const draftPage = await draftContext.newPage();
watchPage(draftPage, "draft");
await draftPage.goto(`${baseUrl}/?theme=dark`, { waitUntil: "networkidle" });
await draftPage.locator("#preview h1").first().waitFor();
await draftPage.locator("#editor").fill("# 恢复测试\n\n这是一段未保存的草稿内容。");
await draftPage.waitForTimeout(1100);
const draftStored = await draftPage.evaluate(() => localStorage.getItem("typero.draft"));
assert.match(draftStored || "", /恢复测试/);
await draftPage.reload({ waitUntil: "networkidle" });
await draftPage.locator("#preview h1").first().waitFor();
assert.match(await draftPage.locator("#editor").inputValue(), /这是一段未保存的草稿内容/);
assert.equal(
  await draftPage.evaluate(() => document.querySelector("#saveIndicator").classList.contains("is-dirty")),
  true,
  "restored draft should be marked unsaved"
);
await draftContext.close();

const headingContext = await browser.newContext({
  viewport: { width: 1200, height: 860 },
  colorScheme: "dark"
});
const headingPage = await headingContext.newPage();
watchPage(headingPage, "headings");
await headingPage.goto(`${baseUrl}/?theme=dark`, { waitUntil: "networkidle" });
await headingPage.locator("#preview h1").first().waitFor();
await headingPage.locator("#editor").fill("Markdown 测试\n=============\n\n## 小节 C#\n\n正文内容。");
await headingPage.waitForTimeout(220);
const headingOutline = await headingPage.evaluate(() =>
  Array.from(document.querySelectorAll(".outline-item")).map((item) => item.textContent)
);
assert.deepEqual(headingOutline, ["Markdown 测试", "小节 C#"]);

await headingPage.evaluate(() => {
  const editor = document.querySelector("#editor");
  editor.value = "alpha beta gamma";
  editor.dispatchEvent(new Event("input", { bubbles: true }));
  editor.focus();
  editor.setSelectionRange(6, 10);
});
await headingPage.keyboard.press("Tab");
await headingPage.waitForTimeout(80);
const tabValue = await headingPage.locator("#editor").inputValue();
assert.match(tabValue, /alpha beta gamma/, "Tab must not discard selected text");
assert.equal(tabValue.split("\n")[0].startsWith("  "), true, "Tab should indent the line");
await headingContext.close();

const printContext = await browser.newContext({
  viewport: { width: 1200, height: 860 },
  colorScheme: "dark"
});
const printPage = await printContext.newPage();
watchPage(printPage, "print");
await printPage.goto(`${baseUrl}/?theme=dark`, { waitUntil: "networkidle" });
await printPage.locator("#preview h1").first().waitFor();
await printPage.pdf({
  path: path.join(screenshotDir, "typero-print.pdf"),
  format: "A4",
  printBackground: true
});
await printPage.emulateMedia({ media: "print" });
await printPage.screenshot({
  path: path.join(screenshotDir, "typero-print.png"),
  fullPage: true
});
await printContext.close();

assert.deepEqual(errors, [], "browser console should have no errors");

console.log("Smoke test passed.");
console.log(JSON.stringify({ initial, saveResult, screenshots: screenshotDir }, null, 2));

await browser.close();
if (serverProcess) {
  serverProcess.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
}
await rm(testRuntimeDir, { recursive: true, force: true });
