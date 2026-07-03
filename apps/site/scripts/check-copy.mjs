import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(root, "..", "..");
const scanned = [join(root, "index.html"), join(root, "src")];
const forbidden = [
  /early\s+access/i,
  /waitlist/i,
  /pricing/i,
  /testimonial/i,
  /customer\s+logo/i,
  /encrypted\s+local\s+storage/i,
  /signed\s+macOS/i,
];
const failures = [];

for (const file of walk(scanned)) {
  const text = readFileSync(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(text)) failures.push(`${file}: ${pattern}`);
  }
}

for (const path of [
  "LICENSE",
  "crates/milim-server/src/lib.rs",
  "apps/desktop/src/api.ts",
  "apps/desktop/src-tauri/src/lib.rs",
  "apps/desktop/src/sessions/store.ts",
  "apps/desktop/src/settings/store.ts",
]) {
  if (!existsSync(join(repoRoot, path))) failures.push(`Missing linked source path: ${path}`);
}

const docsPage = readFileSync(join(root, "src", "DocsPage.tsx"), "utf8");
const serverRouter = readFileSync(join(repoRoot, "crates", "milim-server", "src", "lib.rs"), "utf8");
const documentedEndpoints = [...docsPage.matchAll(/"(?:GET|POST|PUT|DELETE)\s+([^"`]+?)"/g)].map((match) => normalizeRoute(match[1]));
const serverRoutes = new Set([...serverRouter.matchAll(/\.route\(\s*"([^"]+)"/g)].map((match) => normalizeRoute(match[1])));
for (const endpoint of new Set(documentedEndpoints)) {
  if (!serverRoutes.has(endpoint)) failures.push(`Documented endpoint has no server route: ${endpoint}`);
}

if (failures.length) {
  console.error(`Site copy checks failed:\n${failures.join("\n")}`);
  process.exit(1);
}

function walk(paths) {
  const files = [];
  for (const path of paths) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) files.push(...walk([join(path, entry)]));
    } else if (/\.(html|css|ts|tsx)$/.test(path)) {
      files.push(path);
    }
  }
  return files;
}

function normalizeRoute(path) {
  return path.replace(/\{[^}]+}/g, "{}");
}
