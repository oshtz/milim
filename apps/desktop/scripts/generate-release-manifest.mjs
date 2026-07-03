import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  artifactPackageKind,
  artifactPlatform,
  platformForReleaseArtifactName,
  validateArtifactVersions,
  validateExpectedPackageKinds,
} from "./release-manifest-utils.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
const targetRoot = process.argv[2] ? resolveArg(process.argv[2]) : join(appRoot, "src-tauri", "target");
const outputDir = process.argv[3] ? resolveArg(process.argv[3]) : join(appRoot, "release-artifacts");
const expectedVersion = process.env.MILIM_RELEASE_VERSION ?? packageJson.version;
const allowedExtensions = new Set([".dmg", ".exe", ".msi"]);
const release = {
  tag: process.env.MILIM_RELEASE_TAG ?? process.env.GITHUB_REF_NAME ?? "local",
  refType: process.env.GITHUB_REF_TYPE ?? "local",
  refName: process.env.GITHUB_REF_NAME ?? "local",
  commit: process.env.GITHUB_SHA ?? "local",
  runId: process.env.GITHUB_RUN_ID ?? "local",
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "1",
};

if (!existsSync(targetRoot)) {
  throw new Error(`Release target directory does not exist: ${targetRoot}`);
}

const releaseArtifactName = process.env.MILIM_RELEASE_ARTIFACT_NAME ?? "";
const releaseArtifactPlatform = platformForReleaseArtifactName(releaseArtifactName);
const artifacts = findArtifacts(targetRoot)
  .map((path) => {
    const bytes = readFileSync(path);
    const artifactPath = displayPath(path);
    return {
      path: artifactPath,
      platform: artifactPlatform(artifactPath),
      packageKind: artifactPackageKind(artifactPath),
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  })
  .filter((artifact) => !releaseArtifactPlatform || artifact.platform === releaseArtifactPlatform)
  .sort((a, b) => a.path.localeCompare(b.path));

if (artifacts.length === 0) {
  if (releaseArtifactName && releaseArtifactPlatform) {
    throw new Error(
      `No release package artifacts found for MILIM_RELEASE_ARTIFACT_NAME ${releaseArtifactName} (expected platform ${releaseArtifactPlatform}) under ${targetRoot}`,
    );
  }
  throw new Error(`No release package artifacts found under ${targetRoot}`);
}
validateExpectedPackageKinds(artifacts, releaseArtifactName);
validateArtifactVersions(artifacts, expectedVersion);

mkdirSync(outputDir, { recursive: true });
writeFileSync(
  join(outputDir, "manifest.json"),
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      release,
      artifacts,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(
  join(outputDir, "SHA256SUMS.txt"),
  `${artifacts.map((artifact) => `${artifact.sha256}  ${artifact.path}`).join("\n")}\n`,
);

console.log(`Release manifest generated with ${artifacts.length} artifact(s): ${outputDir}`);

function resolveArg(path) {
  return path.match(/^[A-Za-z]:[\\/]/) || path.startsWith("/") ? path : join(appRoot, path);
}

function findArtifacts(root) {
  const found = [];
  visit(root, found);
  return found;
}

function visit(path, found) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      visit(join(path, entry), found);
    }
    return;
  }

  if (!stat.isFile()) return;
  if (!isBundlePath(path)) return;
  if (!allowedExtensions.has(extname(path).toLowerCase())) return;
  found.push(path);
}

function isBundlePath(path) {
  return path.split(/[\\/]+/).some((part) => part === "bundle");
}

function displayPath(path) {
  const fromApp = relative(appRoot, path);
  const selected = isContainedRelative(fromApp) ? fromApp : relative(targetRoot, path);
  return selected.split(/[\\/]+/).join("/");
}

function isContainedRelative(path) {
  return path !== "" && !isAbsolute(path) && path.split(/[\\/]+/)[0] !== "..";
}
