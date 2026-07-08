import { spawnSync } from "node:child_process";
import { deepEqual, equal } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "milim-release-manifest-"));
const appRoot = fileURLToPath(new URL("..", import.meta.url));
try {
  const input = join(root, "input");
  const output = join(root, "output");
  const release = {
    tag: "v0.1.30",
    refType: "tag",
    refName: "v0.1.30",
    commit: "abc123",
    runId: "42",
    runAttempt: "1",
  };

  writeManifest(join(input, "release-manifest-macos"), release, {
    path: "src-tauri/target/universal-apple-darwin/release/bundle/dmg/milim_0.1.30_universal.dmg",
    platform: "macOS Universal",
    packageKind: "DMG",
    size: 10,
    sha256: "a".repeat(64),
  });
  writeManifest(join(input, "release-manifest-windows"), release, {
    path: "src-tauri/target/release/bundle/portable/milim_0.1.30_x64-portable.exe",
    platform: "Windows x64",
    packageKind: "Portable EXE",
    size: 20,
    sha256: "b".repeat(64),
  });

  const result = spawnSync(process.execPath, ["scripts/merge-release-manifests.mjs", input, output], {
    cwd: appRoot,
    encoding: "utf8",
  });
  equal(result.status, 0, result.stderr || result.stdout);

  const merged = JSON.parse(readFileSync(join(output, "manifest.json"), "utf8"));
  deepEqual(merged.release, release);
  deepEqual(
    merged.artifacts.map((artifact) => artifact.path),
    [
      "src-tauri/target/release/bundle/portable/milim_0.1.30_x64-portable.exe",
      "src-tauri/target/universal-apple-darwin/release/bundle/dmg/milim_0.1.30_universal.dmg",
    ],
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

function writeManifest(dir, release, artifact) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify({ generatedAt: "2026-07-08T00:00:00.000Z", release, artifacts: [artifact] })}\n`);
}
