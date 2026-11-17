import http from "node:http";
import crypto from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const root = path.join(projectRoot, "dist");
const args = process.argv.slice(2);
const noOpen = args.includes("--no-open");
const daemon = args.includes("--daemon");
const strictPort = daemon || args.includes("--strict-port");
const portFlagIndex = args.indexOf("--port");
const runtimeFlagIndex = args.indexOf("--runtime");

const preferredPort = portFlagIndex >= 0 ? Number.parseInt(args[portFlagIndex + 1], 10) : 4173;
const runtimeDir =
  runtimeFlagIndex >= 0
    ? path.resolve(args[runtimeFlagIndex + 1])
    : path.join(projectRoot, ".typero");

const secretPath = path.join(runtimeDir, "secret");
const infoPath = path.join(runtimeDir, "server.json");
const secret = crypto.randomBytes(24).toString("base64url");
const appTokens = new Map();
const MAX_FILE_SIZE = 24 * 1024 * 1024;
const MAX_REQUEST_BODY = 30 * 1024 * 1024;
const MARKDOWN_FILE = /\.(md|markdown|mdown|mkd|txt)$/i;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

if (!existsSync(path.join(root, "index.html"))) {
  console.error("Build output dist/index.html was not found.");
  console.error("Run: npm install && npm run build");
  process.exit(1);
}

let runtimeFilesWritten = false;
let cleanedUp = false;

function cleanupRuntime() {
  if (cleanedUp || !runtimeFilesWritten) return;
  cleanedUp = true;
  try {
    unlinkSync(secretPath);
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(infoPath);
  } catch {
    /* ignore */
  }
}

process.on("exit", cleanupRuntime);
process.on("SIGINT", () => {
  cleanupRuntime();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanupRuntime();
  process.exit(0);
});

const server = http.createServer(async (request, response) => {
  let pathname = "/";

  try {
    const requestUrl = new URL(request.url || "/", "http://127.0.0.1");

    try {
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      respondText(response, 400, "Bad Request");
      return;
    }

    if (pathname.startsWith("/api/")) {
      await handleApi(request, response, requestUrl, pathname);
      return;
    }

    if (pathname === "/") pathname = "/index.html";

    const filePath = path.normalize(path.join(root, pathname));
    if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
      respondText(response, 403, "Forbidden");
      return;
    }

    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat || !fileStat.isFile()) {
      respondText(response, 404, "Not Found");
      return;
    }

    const contentType = MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    if (request.method === "HEAD") {
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": fileStat.size,
        "Cache-Control": "no-store"
      });
      response.end();
      return;
    }

    const body = await readFile(filePath);
    respond(response, 200, contentType, body);
  } catch (error) {
    console.error(error);
    if (pathname.startsWith("/api/")) {
      respondJson(response, error.statusCode || 500, {
        ok: false,
        error: error.expose ? error.message : "Internal Server Error"
      });
    } else {
      respondText(response, 500, "Internal Server Error");
    }
  }
});

async function handleApi(request, response, requestUrl, pathname) {
  if (pathname === "/api/ping" && request.method === "GET") {
    respondJson(response, 200, {
      ok: true,
      app: "typero",
      version: 1,
      pid: process.pid
    });
    return;
  }

  if (pathname === "/api/open" && request.method === "POST") {
    requireSecret(request);
    const body = await readJsonBody(request);
    let token = null;
    let appUrl = "/";

    if (body.path) {
      const filePath = path.resolve(String(body.path));
      if (!MARKDOWN_FILE.test(filePath)) {
        throw httpError(400, "只支持 Markdown 或文本文件");
      }

      const fileStat = await stat(filePath).catch(() => null);
      if (!fileStat || !fileStat.isFile()) {
        throw httpError(404, "找不到这个文件");
      }
      if (fileStat.size > MAX_FILE_SIZE) {
        throw httpError(413, "文件过大（超过 24 MB）");
      }

      token = crypto.randomBytes(24).toString("base64url");
      appTokens.set(token, {
        path: filePath,
        name: path.basename(filePath),
        mtime: fileStat.mtimeMs,
        createdAt: Date.now(),
        lastAccess: Date.now()
      });
      appUrl = `/?open=${encodeURIComponent(token)}`;
    }

    const absoluteUrl = `http://127.0.0.1:${server.address().port}${appUrl}`;
    if (!body.noOpen) openBrowser(absoluteUrl);

    respondJson(response, 200, {
      ok: true,
      token,
      url: absoluteUrl,
      name: token ? appTokens.get(token).name : null
    });
    return;
  }

  if (pathname === "/api/document" && request.method === "GET") {
    const token = requestUrl.searchParams.get("token") || "";
    const entry = getTokenEntry(token);
    let content;
    let fileStat;

    try {
      fileStat = await stat(entry.path);
      content = await readFile(entry.path, "utf8");
    } catch {
      throw httpError(404, "找不到这个文件");
    }

    entry.lastAccess = Date.now();
    entry.mtime = fileStat.mtimeMs;
    respondJson(response, 200, {
      ok: true,
      name: entry.name,
      path: entry.path,
      content,
      mtime: entry.mtime
    });
    return;
  }

  if (pathname === "/api/save" && request.method === "POST") {
    const token = requestUrl.searchParams.get("token") || "";
    const entry = getTokenEntry(token);
    const body = await readRequestBody(request);
    const content = body.toString("utf8");

    await writeFile(entry.path, content, "utf8");
    const fileStat = await stat(entry.path);
    entry.mtime = fileStat.mtimeMs;
    entry.lastAccess = Date.now();

    respondJson(response, 200, {
      ok: true,
      mtime: entry.mtime
    });
    return;
  }

  if (pathname === "/api/shutdown" && request.method === "POST") {
    requireSecret(request);
    respondJson(response, 200, { ok: true });
    setTimeout(() => {
      cleanupRuntime();
      process.exit(0);
    }, 120);
    return;
  }

  respondJson(response, 404, { ok: false, error: "Not Found" });
}

function requireSecret(request) {
  if (request.headers["x-typero-secret"] !== secret) {
    throw httpError(403, "Forbidden");
  }
}

function getTokenEntry(token) {
  if (!token || !appTokens.has(token)) {
    throw httpError(404, "文稿会话不存在或已过期");
  }
  return appTokens.get(token);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.expose = true;
  return error;
}

function readJsonBody(request) {
  return readRequestBody(request).then((buffer) => {
    try {
      const value = JSON.parse(buffer.toString("utf8") || "{}");
      return value && typeof value === "object" ? value : {};
    } catch {
      throw httpError(400, "Invalid JSON");
    }
  });
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let rejected = false;

    request.on("data", (chunk) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_REQUEST_BODY) {
        rejected = true;
        reject(httpError(413, "内容过大"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    request.on("error", reject);
  });
}

function respondJson(response, statusCode, payload) {
  respond(response, statusCode, "application/json; charset=utf-8", JSON.stringify(payload));
}

function respondText(response, statusCode, message) {
  respond(response, statusCode, "text/plain; charset=utf-8", message);
}

function respond(response, status, contentType, body) {
  if (response.headersSent) return;
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer"
  });
  response.end(body);
}

function listen(port, attemptsLeft = 20) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      if (error.code === "EADDRINUSE" && attemptsLeft > 0 && !strictPort) {
        resolve(listen(port + 1, attemptsLeft - 1));
      } else {
        reject(error);
      }
    };

    const onListening = () => {
      server.off("error", onError);
      resolve(port);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function browserCandidates() {
  if (process.platform !== "win32") return [];

  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA || "";

  const edge = [
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe")
  ];

  const chrome = [
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    localAppData ? path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe") : ""
  ];

  return [...edge, ...chrome].filter(Boolean);
}

function openBrowser(url) {
  if (process.platform === "win32") {
    const executable = browserCandidates().find((candidate) => existsSync(candidate));
    if (executable) {
      try {
        const child = spawn(executable, [`--app=${url}`, "--window-size=1420,920"], {
          detached: true,
          stdio: "ignore"
        });
        child.on("error", () => openWithShell(url));
        child.unref();
        return;
      } catch {
        /* fall through to the default browser */
      }
    }
    openWithShell(url);
    return;
  }

  const command = process.platform === "darwin" ? "open" : "xdg-open";
  try {
    const child = spawn(command, [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* Nothing else to do. */
  }
}

function openWithShell(url) {
  try {
    const child = spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* The URL is still printed below. */
  }
}

async function writeRuntimeFiles(port) {
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(secretPath, secret, { encoding: "utf8", mode: 0o600 });
  runtimeFilesWritten = true;
  await writeFile(
    infoPath,
    JSON.stringify(
      {
        pid: process.pid,
        port,
        url: `http://127.0.0.1:${port}`,
        startedAt: Date.now()
      },
      null,
      2
    ),
    "utf8"
  );
}

try {
  const port = await listen(Number.isFinite(preferredPort) ? preferredPort : 4173);
  await writeRuntimeFiles(port);
  const url = `http://127.0.0.1:${port}`;

  console.log("");
  console.log("  Typero - Markdown Studio");
  console.log("  -------------------------");
  console.log(`  Local:  ${url}`);
  console.log("  Listening on this machine only.");
  if (!daemon) console.log("  Close this window or press Ctrl+C to exit.");
  console.log("");

  if (!noOpen && !daemon) openBrowser(url);
} catch (error) {
  console.error("Typero failed to start:", error);
  process.exit(1);
}
