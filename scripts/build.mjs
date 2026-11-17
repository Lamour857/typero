import { build } from "esbuild";
import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "dist");
const assetsDir = path.join(outDir, "assets");
const dev = process.argv.includes("--dev");

await rm(outDir, { recursive: true, force: true });
await mkdir(assetsDir, { recursive: true });

await copyFile(path.join(root, "src", "index.html"), path.join(outDir, "index.html"));

await build({
  entryPoints: [path.join(root, "src", "app.js")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome100", "edge100"],
  outfile: path.join(assetsDir, "app.js"),
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  legalComments: "none",
  loader: { ".md": "text" },
  logLevel: "info"
});

await build({
  entryPoints: [path.join(root, "src", "styles.css")],
  bundle: true,
  outfile: path.join(assetsDir, "app.css"),
  minify: !dev,
  loader: {
    ".woff2": "file",
    ".woff": "file",
    ".ttf": "file",
    ".eot": "file",
    ".svg": "file"
  },
  assetNames: "fonts/[name]-[hash]",
  logLevel: "info"
});

const jsSize = (await stat(path.join(assetsDir, "app.js"))).size;
const cssSize = (await stat(path.join(assetsDir, "app.css"))).size;
const formatSize = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

console.log("");
console.log(`Typero built${dev ? " (development)" : ""}`);
console.log(`  dist/index.html`);
console.log(`  dist/assets/app.js   ${formatSize(jsSize)}`);
console.log(`  dist/assets/app.css  ${formatSize(cssSize)}`);
