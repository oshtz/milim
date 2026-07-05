import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const filters = process.argv.slice(2);

if (!filters.length) {
  throw new Error("Usage: node tests/run-tauri-rust-test.mjs <cargo test filter> [...]");
}

const env = { ...process.env };

if (process.platform === "win32") {
  const manifest = join(root, "src-tauri", "windows-test-manifest.xml");
  env.RUSTFLAGS = [
    env.RUSTFLAGS ?? "",
    "-C",
    "link-arg=/MANIFEST:EMBED",
    "-C",
    `link-arg=/MANIFESTINPUT:${manifest}`,
  ]
    .filter(Boolean)
    .join(" ");
}

const result = spawnSync(
  "cargo",
  ["test", "--manifest-path", "src-tauri/Cargo.toml", "--lib", ...filters],
  {
    cwd: root,
    env,
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(`Tauri Rust test failed with exit ${result.status}`);
}
