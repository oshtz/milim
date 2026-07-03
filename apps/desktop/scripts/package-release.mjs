import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const platformArgs = {
  win32: ["tauri", "build", "--no-bundle"],
  darwin: ["tauri", "build", "--target", "universal-apple-darwin", "--bundles", "dmg"],
};

const args = platformArgs[process.platform];
if (!args) {
  console.error("Linux release packaging is intentionally disabled. Release builds currently publish Windows portable EXE and macOS universal DMG only.");
  process.exit(1);
}

const result = spawnSync(pnpm, args, {
  cwd: appRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
