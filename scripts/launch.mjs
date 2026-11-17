import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let filePath = null;
let stop = false;
let noOpen = false;
let port = Number.parseInt(process.env.TYPERO_PORT || "4173", 10);
let runtimeDir = path.join(root, ".typero");
let serverSpawnedAt = 0;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--file") {
    filePath = args[index + 1] || null;
    index += 1;
  } else if (arg === "--stop") {
    stop = true;
  } else if (arg === "--no-open") {
    noOpen = true;
  } else if (arg === "--port") {
    port = Number.parseInt(args[index + 1] || "", 10);
    index += 1;
  } else if (arg === "--runtime") {
    runtimeDir = path.resolve(args[index + 1] || "");
    index += 1;
  } else if (!arg.startsWith("--") && !filePath) {
    filePath = arg;
  }
}

if (!Number.isFinite(port) || port <= 0 || port > 65535) {
  port = 4173;
}
if (filePath) filePath = path.resolve(filePath);

const baseUrl = `http://127.0.0.1:${port}`;
const logPath = path.join(runtimeDir, "launcher.log");

try {
  if (stop) {
    await stopService();
  } else {
    await openInTypero();
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  await writeLog(`${new Date().toISOString()}  ${message}`);
  process.exitCode = 1;
}

async function openInTypero() {
  await ensureServer();
  const secret = await waitForSecret(8000, serverSpawnedAt);
  const payload = { noOpen };
  if (filePath) payload.path = filePath;

  const response = await fetch(`${baseUrl}/api/open`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Typero-Secret": secret
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`无法在 Typero 中打开文稿（HTTP ${response.status}）：${details}`);
  }

  const data = await response.json();
  console.log(`Typero: ${data.url}`);
}

async function stopService() {
  if (!(await isTyperoRunning())) {
    console.log("Typero 本地服务未在运行。");
    return;
  }

  const secret = await waitForSecret(2000);
  if (!secret) throw new Error("无法读取 Typero 本地服务凭据。");

  const response = await fetch(`${baseUrl}/api/shutdown`, {
    method: "POST",
    headers: { "X-Typero-Secret": secret },
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    throw new Error(`停止 Typero 本地服务失败（HTTP ${response.status}）。`);
  }

  console.log("Typero 本地服务已停止。已打开的 Typero 窗口需要手动关闭。");
}

async function ensureServer() {
  if (await isTyperoRunning()) return;

  await mkdir(runtimeDir, { recursive: true });
  await writeLog(`${new Date().toISOString()}  starting local service on port ${port}`);

  const logFd = openSync(logPath, "a");
  let child;
  serverSpawnedAt = Date.now();
  try {
    child = spawn(
      process.execPath,
      [
        path.join(root, "server.mjs"),
        "--daemon",
        "--port",
        String(port),
        "--runtime",
        runtimeDir
      ],
      {
        cwd: root,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", logFd, logFd]
      }
    );
  } finally {
    closeSync(logFd);
  }

  child.on("error", (error) => {
    writeLog(`${new Date().toISOString()}  failed to spawn server: ${error.message}`);
  });
  child.unref();

  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if (await isTyperoRunning()) return;
    await delay(150);
  }

  throw new Error(
    `Typero 本地服务启动超时。请确认端口 ${port} 未被其他程序占用，详见 ${logPath}`
  );
}

async function isTyperoRunning() {
  try {
    const response = await fetch(`${baseUrl}/api/ping`, {
      signal: AbortSignal.timeout(900)
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data?.app === "typero";
  } catch {
    return false;
  }
}

async function waitForSecret(timeout = 8000, minMtime = 0) {
  const secretPath = path.join(runtimeDir, "secret");
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const info = await stat(secretPath);
      if (info.mtimeMs + 1000 >= minMtime) {
        const value = (await readFile(secretPath, "utf8")).trim();
        if (value) return value;
      }
    } catch {
      /* The server may still be writing its runtime files. */
    }
    await delay(100);
  }
  throw new Error("无法读取 Typero 本地服务凭据，请查看 launcher.log。");
}

async function writeLog(line) {
  try {
    await mkdir(runtimeDir, { recursive: true });
    await appendFile(logPath, `${line}\n`, "utf8");
  } catch {
    /* Logging must never prevent the launcher from reporting its own error. */
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
