import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";

const root = fileURLToPath(new URL("..", import.meta.url));
const binary = findReleaseBinary();
const healthUrl = "http://127.0.0.1:7377/health";

if (!existsSync(binary)) {
  throw new Error(`Release binary not found. Run npm run package:release first. Missing: ${binary}`);
}

if (await isPortOpen(7377)) {
  throw new Error("Port 7377 is already in use. Close the running desktop app before running the release launch smoke.");
}

const milimHome = mkdtempSync(join(tmpdir(), "milim-release-smoke-"));
const child = spawn(binary, [], {
  cwd: root,
  env: { ...process.env, MILIM_HOME: milimHome, RUST_BACKTRACE: process.env.RUST_BACKTRACE ?? "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
let failure;

child.stdout?.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForHealth(20_000);
  console.log(`Release binary health check passed: ${healthUrl}`);
} catch (err) {
  failure = err;
} finally {
  child.kill();
  await waitForExit(child, 5_000).catch(() => {});
  rmSync(milimHome, { recursive: true, force: true });
}

if (failure) {
  throw new Error(`${failure.message}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function waitForHealth(timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode != null) {
      throw new Error(`Release binary exited before health was ready with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(healthUrl);
      if (response.ok) return;
    } catch {
      // The embedded backend is still starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for release health endpoint: ${healthUrl}`);
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function waitForExit(process, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (process.exitCode != null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => reject(new Error("Timed out waiting for release binary to exit.")), timeoutMs);
    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findReleaseBinary() {
  const exe = process.platform === "win32" ? "milim-desktop.exe" : "milim-desktop";
  const candidates =
    process.platform === "darwin"
      ? [
          join(root, "src-tauri", "target", "universal-apple-darwin", "release", exe),
          join(root, "src-tauri", "target", "aarch64-apple-darwin", "release", exe),
          join(root, "src-tauri", "target", "x86_64-apple-darwin", "release", exe),
          join(root, "src-tauri", "target", "release", exe),
        ]
      : [join(root, "src-tauri", "target", "release", exe)];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}
