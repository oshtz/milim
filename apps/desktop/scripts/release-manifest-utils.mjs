import { basename, isAbsolute } from "node:path";

export const RELEASE_METADATA_KEYS = ["tag", "refType", "refName", "commit", "runId", "runAttempt"];

export function artifactPlatform(artifactOrPath) {
  const path = artifactPath(artifactOrPath);
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const name = basename(normalized);
  if (name.endsWith(".msi") || name.endsWith(".exe")) return "Windows x64";
  if (name.endsWith(".dmg")) {
    if (normalized.includes("universal-apple-darwin") || normalized.includes("universal")) return "macOS Universal";
    if (normalized.includes("aarch64-apple-darwin") || normalized.includes("aarch64")) return "macOS Apple Silicon";
    if (normalized.includes("x86_64-apple-darwin") || normalized.includes("x86_64")) return "macOS Intel";
    return "macOS";
  }
  return "Unknown";
}

export function artifactPackageKind(artifactOrPath) {
  const path = artifactPath(artifactOrPath);
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  const name = basename(normalized);
  if (name.endsWith(".msi")) return "MSI installer";
  if (normalized.includes("/bundle/portable/") || name.endsWith("-portable.exe")) return "Portable EXE";
  if (name.endsWith(".exe")) return "NSIS installer";
  if (name.endsWith(".dmg")) return "DMG";
  return "Release package";
}

export function artifactVersion(artifactOrPath) {
  const name = basename(artifactPath(artifactOrPath));
  return name.match(/(?:^|[_-])v?(\d+\.\d+\.\d+)(?=[_\-.]|$)/i)?.[1] ?? null;
}

export function parseSha256Sums(text) {
  const parsed = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/);
    if (!match) throw new Error(`Invalid SHA256SUMS line: ${line}`);
    if (parsed.has(match[2])) throw new Error(`Duplicate SHA256SUMS entry: ${match[2]}`);
    parsed.set(match[2], match[1]);
  }
  return parsed;
}

export function validateManifestArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") throw new Error("Manifest artifact must be an object.");
  if (typeof artifact.path !== "string" || !artifact.path.trim()) {
    throw new Error(`Manifest artifact has invalid path: ${JSON.stringify(artifact)}`);
  }
  const pathParts = artifact.path.split(/[\\/]+/);
  if (isAbsolutePath(artifact.path) || pathParts.includes("..")) {
    throw new Error(`Manifest artifact path must be relative and contained: ${artifact.path}`);
  }
  if (typeof artifact.platform !== "string" || !artifact.platform.trim()) {
    throw new Error(`Manifest artifact has invalid platform: ${JSON.stringify(artifact)}`);
  }
  if (artifact.platform !== artifactPlatform(artifact.path)) {
    throw new Error(`Manifest artifact platform mismatch: expected ${artifactPlatform(artifact.path)} for ${artifact.path}`);
  }
  if (typeof artifact.packageKind !== "string" || !artifact.packageKind.trim()) {
    throw new Error(`Manifest artifact has invalid packageKind: ${JSON.stringify(artifact)}`);
  }
  if (artifact.packageKind !== artifactPackageKind(artifact.path)) {
    throw new Error(`Manifest artifact packageKind mismatch: expected ${artifactPackageKind(artifact.path)} for ${artifact.path}`);
  }
  if (!Number.isInteger(artifact.size) || artifact.size <= 0) {
    throw new Error(`Manifest artifact has invalid size: ${JSON.stringify(artifact)}`);
  }
  if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) {
    throw new Error(`Manifest artifact has invalid sha256: ${JSON.stringify(artifact)}`);
  }
}

export function validateReleaseMetadata(release) {
  if (!release || typeof release !== "object") {
    throw new Error("Release manifest is missing release metadata.");
  }
  for (const key of RELEASE_METADATA_KEYS) {
    if (typeof release[key] !== "string" || release[key].trim() === "") {
      throw new Error(`Release manifest release metadata is missing ${key}.`);
    }
  }
}

export function validateArtifactVersions(artifacts, expectedVersion) {
  if (!expectedVersion) return;
  for (const artifact of artifacts) {
    const version = artifactVersion(artifact);
    if (version && version !== expectedVersion) {
      throw new Error(`Release artifact ${artifact.path} version ${version} does not match expected ${expectedVersion}`);
    }
  }
}

export function platformForReleaseArtifactName(name) {
  const platform = knownPlatformForReleaseArtifactName(name);
  if (platform || !name || name === "local") return platform;
  throw new Error(`Unknown MILIM_RELEASE_ARTIFACT_NAME ${name}`);
}

export function validateExpectedPackageKinds(artifacts, name) {
  const expectedPlatform = knownPlatformForReleaseArtifactName(name);
  if (expectedPlatform) {
    for (const artifact of artifacts) {
      if (artifact.platform !== expectedPlatform) {
        throw new Error(`Release artifact ${name} includes ${artifact.platform} package ${artifact.path}; expected ${expectedPlatform}`);
      }
    }
  }

  const expectedKinds = expectedPackageKindsForReleaseArtifactName(name);
  if (expectedKinds.length === 0) return;
  for (const expectedKind of expectedKinds) {
    const matchingArtifacts = artifacts.filter((artifact) => artifact.packageKind === expectedKind);
    if (matchingArtifacts.length === 0) {
      throw new Error(`Release artifact ${name} is missing expected package kind ${expectedKind}`);
    }
    if (matchingArtifacts.length !== 1) {
      throw new Error(
        `Release artifact ${name} has ${matchingArtifacts.length} packages of kind ${expectedKind}; expected exactly 1`,
      );
    }
  }
  if (artifacts.some((artifact) => !expectedKinds.includes(artifact.packageKind))) {
    const actualKinds = artifacts.map((artifact) => artifact.packageKind).join(", ");
    throw new Error(
      `Release artifact ${name} has unexpected package set ${actualKinds}; expected exactly ${expectedKinds.join(", ")}`,
    );
  }
}

function expectedPackageKindsForReleaseArtifactName(name) {
  if (!name || name === "local") return [];
  const normalized = name.toLowerCase();
  if (normalized.endsWith("windows-x64")) return ["Portable EXE"];
  if (normalized.endsWith("macos-universal") || normalized.endsWith("macos-aarch64") || normalized.endsWith("macos-x86_64")) return ["DMG"];
  return [];
}

function knownPlatformForReleaseArtifactName(name) {
  if (!name || name === "local") return "";
  const normalized = name.toLowerCase();
  if (normalized.endsWith("macos-universal")) return "macOS Universal";
  if (normalized.endsWith("macos-aarch64")) return "macOS Apple Silicon";
  if (normalized.endsWith("macos-x86_64")) return "macOS Intel";
  if (normalized.endsWith("windows-x64")) return "Windows x64";
  return "";
}

function isAbsolutePath(path) {
  return isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("//");
}

function artifactPath(artifactOrPath) {
  if (typeof artifactOrPath === "string") return artifactOrPath;
  if (artifactOrPath && typeof artifactOrPath.path === "string") return artifactOrPath.path;
  return "";
}
