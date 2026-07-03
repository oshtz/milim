import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
const tauriConfig = JSON.parse(readFileSync(join(appRoot, "src-tauri", "tauri.conf.json"), "utf8"));
const platform = process.env.MILIM_RELEASE_PORTABLE_PLATFORM ?? process.platform;
const targetRoot = process.argv[2] ? resolveArg(process.argv[2]) : join(appRoot, "src-tauri", "target");
const productName = process.env.MILIM_RELEASE_PRODUCT_NAME ?? tauriConfig.productName ?? packageJson.name;
const version = process.env.MILIM_RELEASE_VERSION ?? tauriConfig.version ?? packageJson.version;

if (platform !== "win32") {
  console.log(`Skipping Windows portable release artifact on ${platform}.`);
  process.exit(0);
}

const releaseBinary = join(targetRoot, "release", "milim-desktop.exe");
if (!existsSync(releaseBinary)) {
  throw new Error(`Windows release binary is missing: ${releaseBinary}`);
}
const releaseBinaryStat = statSync(releaseBinary);
if (!releaseBinaryStat.isFile() || releaseBinaryStat.size <= 0) {
  throw new Error(`Windows release binary is not a non-empty file: ${releaseBinary}`);
}

const portableDir = join(targetRoot, "release", "bundle", "portable");
const portableBinary = join(portableDir, `${productName}_${version}_x64-portable.exe`);
mkdirSync(portableDir, { recursive: true });
for (const entry of readdirSync(portableDir)) {
  if (entry.startsWith(`${productName}_`) && entry.endsWith("_x64-portable.exe") && entry !== basename(portableBinary)) {
    unlinkSync(join(portableDir, entry));
  }
  if (entry.startsWith(`${productName}_`) && entry.endsWith("_x64-portable.exe.sha256") && entry !== `${basename(portableBinary)}.sha256`) {
    unlinkSync(join(portableDir, entry));
  }
}
copyFileSync(releaseBinary, portableBinary);
writeFileSync(
  `${portableBinary}.sha256`,
  `${createHash("sha256").update(readFileSync(portableBinary)).digest("hex")}  ${basename(portableBinary)}\n`,
);

const portableStat = statSync(portableBinary);
if (!portableStat.isFile() || portableStat.size !== releaseBinaryStat.size) {
  throw new Error(`Windows portable release artifact was not copied correctly: ${portableBinary}`);
}

console.log(`Windows portable release artifact staged: ${portableBinary}`);
console.log(`package=${basename(portableBinary)}`);

function resolveArg(path) {
  return isAbsolutePath(path) ? path : join(appRoot, path);
}

function isAbsolutePath(path) {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith(`${sep}${sep}`);
}
