import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const scanRoots = ["src", "src-tauri/src", "src-tauri/Cargo.toml"].map((p) => join(root, p));
const allowedExtensions = new Set([".css", ".rs", ".toml", ".ts", ".tsx"]);
const banned = /[\ufffd\u2014\u2026\u2190-\u21ff\u2600-\u27bf\u{1f000}-\u{1faff}]/u;
const findings = [];

function extension(path) {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot) : "";
}

function files(path) {
  const stat = statSync(path);
  if (stat.isFile()) return allowedExtensions.has(extension(path)) ? [path] : [];
  return readdirSync(path).flatMap((name) => {
    if (["dist", "node_modules", "target"].includes(name)) return [];
    return files(join(path, name));
  });
}

for (const file of scanRoots.flatMap(files)) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (banned.test(line)) findings.push(`${file}:${index + 1}: ${line.trim()}`);
  });
}

if (findings.length) {
  throw new Error(`Desktop app copy contains banned punctuation or emoji:\n${findings.join("\n")}`);
}
