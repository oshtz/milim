import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { RELEASE_METADATA_KEYS, validateManifestArtifact, validateReleaseMetadata } from "./release-manifest-utils.mjs";

const inputRoot = process.argv[2];
const outputDir = process.argv[3];

if (!inputRoot || !outputDir) {
  throw new Error("Usage: node scripts/merge-release-manifests.mjs <input-root> <output-dir>");
}
if (!existsSync(inputRoot)) {
  throw new Error(`Release manifest input directory does not exist: ${inputRoot}`);
}

const manifestPaths = findManifests(inputRoot);
if (manifestPaths.length === 0) {
  throw new Error(`No release manifest files found under ${inputRoot}`);
}

let release = null;
const artifacts = [];
const artifactPaths = new Set();

for (const path of manifestPaths) {
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  validateReleaseMetadata(manifest.release);
  if (!release) {
    release = manifest.release;
  } else {
    for (const key of RELEASE_METADATA_KEYS) {
      if (manifest.release[key] !== release[key]) {
        throw new Error(`Release manifest ${path} has mismatched ${key}: ${manifest.release[key]} !== ${release[key]}`);
      }
    }
  }

  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    throw new Error(`Release manifest ${path} has no artifacts.`);
  }
  for (const artifact of manifest.artifacts) {
    validateManifestArtifact(artifact);
    if (artifactPaths.has(artifact.path)) {
      throw new Error(`Duplicate release artifact in manifests: ${artifact.path}`);
    }
    artifactPaths.add(artifact.path);
    artifacts.push(artifact);
  }
}

artifacts.sort((a, b) => a.path.localeCompare(b.path));
mkdirSync(outputDir, { recursive: true });
writeFileSync(
  join(outputDir, "manifest.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), release, artifacts }, null, 2)}\n`,
);

console.log(`Merged ${manifestPaths.length} release manifest(s) with ${artifacts.length} artifact(s): ${outputDir}`);

function findManifests(root) {
  const found = [];
  visit(root, found);
  return found.sort();
}

function visit(path, found) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      visit(join(path, entry), found);
    }
    return;
  }
  if (stat.isFile() && basename(path) === "manifest.json") {
    found.push(path);
  }
}
