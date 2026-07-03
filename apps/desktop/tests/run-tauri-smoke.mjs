import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const targetDir = join(root, "src-tauri", "target", "tauri-verify");
const tauriCli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");

const result = spawnSync(process.execPath, [tauriCli, "build", "--debug", "--no-bundle"], {
  cwd: root,
  env: { ...process.env, CARGO_TARGET_DIR: targetDir },
  stdio: "inherit",
});

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Tauri smoke build failed with exit ${result.status}`);
}
