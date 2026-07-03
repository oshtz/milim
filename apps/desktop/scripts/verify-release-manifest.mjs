import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseSha256Sums,
  validateArtifactVersions,
  validateExpectedPackageKinds,
  validateManifestArtifact,
  validateReleaseMetadata,
} from "./release-manifest-utils.mjs";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8"));
const manifestDir = process.argv[2] ? resolveArg(process.argv[2], appRoot) : join(appRoot, "release-artifacts");
const artifactRoot = process.argv[3] ? resolveArg(process.argv[3], appRoot) : appRoot;
const expectedVersion = process.env.MILIM_RELEASE_VERSION ?? packageJson.version;
const manifestPath = join(manifestDir, "manifest.json");
const sumsPath = join(manifestDir, "SHA256SUMS.txt");

if (!existsSync(manifestPath)) throw new Error(`Missing release manifest: ${manifestPath}`);
if (!existsSync(sumsPath)) throw new Error(`Missing release checksums: ${sumsPath}`);

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const releaseArtifactName = process.env.MILIM_RELEASE_ARTIFACT_NAME ?? "";
validateReleaseMetadata(manifest.release);
if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
  throw new Error("Release manifest must include at least one artifact.");
}
validateExpectedPackageKinds(manifest.artifacts, releaseArtifactName);
validateArtifactVersions(manifest.artifacts, expectedVersion);

const sums = parseSha256Sums(readFileSync(sumsPath, "utf8"));
if (sums.size !== manifest.artifacts.length) {
  throw new Error(`SHA256SUMS artifact count mismatch: expected ${manifest.artifacts.length}, got ${sums.size}`);
}

for (const artifact of manifest.artifacts) {
  validateManifestArtifact(artifact);
  const expectedHash = sums.get(artifact.path);
  if (!expectedHash) throw new Error(`SHA256SUMS.txt is missing ${artifact.path}`);
  if (expectedHash !== artifact.sha256) {
    throw new Error(`checksum mismatch for ${artifact.path}: manifest=${artifact.sha256} sums=${expectedHash}`);
  }

  const file = resolveArtifactPath(artifact.path);
  if (!existsSync(file)) throw new Error(`release artifact is missing: ${artifact.path}`);
  const stat = statSync(file);
  if (!stat.isFile()) throw new Error(`release artifact is not a file: ${artifact.path}`);
  if (stat.size !== artifact.size) {
    throw new Error(`size mismatch for ${artifact.path}: manifest=${artifact.size} actual=${stat.size}`);
  }

  const actualHash = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (actualHash !== artifact.sha256) {
    throw new Error(`checksum mismatch for ${artifact.path}: manifest=${artifact.sha256} actual=${actualHash}`);
  }
}

console.log(`Release manifest verified with ${manifest.artifacts.length} artifact(s): ${manifestDir}`);

function resolveArg(path, base) {
  return path.match(/^[A-Za-z]:[\\/]/) || path.startsWith("/") ? path : join(base, path);
}

function resolveArtifactPath(path) {
  return join(artifactRoot, ...path.split(/[\\/]+/));
}
