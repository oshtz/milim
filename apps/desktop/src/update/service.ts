export type GitHubReleaseAsset = {
  name: string;
  url?: string;
  browser_download_url: string;
};

type GitHubRelease = {
  tag_name: string;
  body?: string | null;
  published_at?: string | null;
  assets?: GitHubReleaseAsset[];
};

export type UpdateInfo = {
  version: string;
  notes: string | null;
  publishedAt: string | null;
  assetName: string;
  downloadUrl: string;
  checksumUrl: string;
};

type AssetConfig = {
  name: string;
  extension: string;
  matches: (asset: GitHubReleaseAsset) => boolean;
};

export const AUTO_UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000;
const GITHUB_REPO = "oshtz/milim";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isDevBuild(): boolean {
  return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
}

export function normalizeVersion(version: string): string {
  return version.trim().replace(/^v/i, "").split("-")[0];
}

export function compareVersions(left: string, right: string): number {
  const leftParts = normalizeVersion(left).split(".").map((part) => Number(part) || 0);
  const rightParts = normalizeVersion(right).split(".").map((part) => Number(part) || 0);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index++) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }

  return 0;
}

export function shouldRunAutoUpdateCheck(lastCheckedAt: number | null, now = Date.now()): boolean {
  return !lastCheckedAt || now - lastCheckedAt >= AUTO_UPDATE_INTERVAL_MS;
}

export function getAssetConfigForPlatform(os: string): AssetConfig {
  if (os === "darwin") {
    return {
      name: "milim.app.zip",
      extension: ".app.zip",
      matches: (asset) => asset.name === "milim.app.zip",
    };
  }

  if (os === "win32") {
    return {
      name: "Windows portable EXE",
      extension: ".exe",
      matches: (asset) => {
        const name = asset.name.toLowerCase();
        return name.endsWith("_x64-portable.exe") || name.endsWith("-portable.exe");
      },
    };
  }

  throw new Error("Auto-update is not supported on this platform.");
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    if (response.status === 403) throw new Error("GitHub API rate limit exceeded. Try again later.");
    throw new Error(`GitHub API request failed (${response.status})`);
  }

  return response.json() as Promise<T>;
}

async function downloadBinary(url: string): Promise<Uint8Array> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/octet-stream",
    },
  });

  if (!response.ok) throw new Error(`Update download failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "text/plain, application/octet-stream",
    },
  });

  if (!response.ok) throw new Error(`Checksum download failed (${response.status})`);
  return response.text();
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hashInput = Uint8Array.from(bytes);
  const digest = await crypto.subtle.digest("SHA-256", hashInput.buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function selectUpdateAssets(
  assets: GitHubReleaseAsset[],
  assetConfig: AssetConfig,
): { asset: GitHubReleaseAsset; checksumAsset: GitHubReleaseAsset } {
  const asset = assets.find(assetConfig.matches);
  if (!asset) throw new Error("No compatible update asset found for this platform.");

  const checksumAsset =
    assets.find((entry) => entry.name === `${asset.name}.sha256`) ??
    assets.find((entry) => entry.name.toLowerCase() === "sha256sums.txt") ??
    assets.find((entry) => entry.name.toLowerCase() === "checksums.txt");

  if (!checksumAsset) throw new Error(`No SHA-256 checksum asset found for ${asset.name}.`);
  return { asset, checksumAsset };
}

export function getAssetDownloadUrl(asset: GitHubReleaseAsset): string {
  return asset.url ?? asset.browser_download_url;
}

export function parseExpectedSha256(checksumText: string, assetName: string): string | null {
  const lines = checksumText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const hashPattern = /[a-f0-9]{64}/i;
  const assetBaseName = assetName.split(/[\\/]/).pop() ?? assetName;
  const matchingLine = lines.find((line) => line.includes(assetName) && hashPattern.test(line))
    ?? lines.find((line) => line.includes(assetBaseName) && hashPattern.test(line));
  const fallbackLine = lines.length === 1 ? lines.find((line) => hashPattern.test(line)) : undefined;
  const match = (matchingLine ?? fallbackLine)?.match(hashPattern);
  return match?.[0].toLowerCase() ?? null;
}

export async function verifyChecksum(bytes: Uint8Array, checksumText: string, assetName: string): Promise<void> {
  const expected = parseExpectedSha256(checksumText, assetName);
  if (!expected) throw new Error(`Checksum file does not contain a SHA-256 hash for ${assetName}.`);
  const actual = await sha256Hex(bytes);
  if (actual !== expected) throw new Error(`Update checksum mismatch for ${assetName}.`);
}

export function getUpdateFileName(update: UpdateInfo, os: string): string {
  return os === "darwin" ? `milim-${update.version}.app.zip` : `milim-${update.version}.exe`;
}

export type UpdateDownloadServices = {
  downloadBinary: (url: string) => Promise<Uint8Array>;
  fetchText: (url: string) => Promise<string>;
  getPlatform: () => Promise<string>;
  writeUpdateFile: (fileName: string, contents: Uint8Array) => Promise<string>;
  extractAppZip: (zipPath: string) => Promise<string>;
};

export async function downloadUpdateWithServices(
  update: UpdateInfo,
  services: UpdateDownloadServices,
): Promise<string> {
  const binary = await services.downloadBinary(update.downloadUrl);
  const checksumText = await services.fetchText(update.checksumUrl);
  await verifyChecksum(binary, checksumText, update.assetName);

  const os = await services.getPlatform();
  const updatePath = await services.writeUpdateFile(getUpdateFileName(update, os), binary);
  return os === "darwin" ? services.extractAppZip(updatePath) : updatePath;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (!isTauriRuntime() || isDevBuild()) return null;

  const { getVersion } = await import("@tauri-apps/api/app");
  const { invoke } = await import("@tauri-apps/api/core");
  const currentVersion = await getVersion();
  const release = await fetchJson<GitHubRelease>(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`);
  const latestVersion = normalizeVersion(release.tag_name || "");
  if (!latestVersion || compareVersions(latestVersion, currentVersion) <= 0) return null;

  const os = await invoke<string>("get_update_platform");
  const { asset, checksumAsset } = selectUpdateAssets(release.assets ?? [], getAssetConfigForPlatform(os));
  return {
    version: latestVersion,
    notes: release.body ?? null,
    publishedAt: release.published_at ?? null,
    assetName: asset.name,
    downloadUrl: getAssetDownloadUrl(asset),
    checksumUrl: getAssetDownloadUrl(checksumAsset),
  };
}

export async function downloadUpdate(update: UpdateInfo): Promise<string> {
  if (!isTauriRuntime()) throw new Error("Updates require the desktop app.");

  const { invoke } = await import("@tauri-apps/api/core");
  return downloadUpdateWithServices(update, {
    downloadBinary,
    fetchText,
    getPlatform: () => invoke<string>("get_update_platform"),
    writeUpdateFile: (fileName, contents) =>
      invoke<string>("write_update_file", { fileName, contents: Array.from(contents) }),
    extractAppZip: (zipPath) => invoke<string>("extract_app_zip", { zipPath }),
  });
}

export async function installUpdate(updatePath: string): Promise<void> {
  if (!isTauriRuntime()) throw new Error("Updates require the desktop app.");
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("apply_update", { updatePath });
}
