import { deepEqual, equal, rejects, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AUTO_UPDATE_INTERVAL_MS,
  compareVersions,
  downloadUpdateWithServices,
  getAssetConfigForPlatform,
  getAssetDownloadUrl,
  getUpdateFileName,
  parseExpectedSha256,
  selectUpdateAssets,
  shouldRunAutoUpdateCheck,
  verifyChecksum,
  type GitHubReleaseAsset,
  type UpdateDownloadServices,
  type UpdateInfo,
} from "../src/update/service.js";

const SHA_A = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SHA_B = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const UPDATE_BYTES = new TextEncoder().encode("milim-update");
const updateStoreSource = readFileSync("src/update/store.ts", "utf8");

function asset(
  name: string,
  browserUrl = `https://github.com/oshtz/milim/releases/download/v1/${name}`,
  apiUrl = `https://api.github.com/repos/oshtz/milim/releases/assets/${encodeURIComponent(name)}`,
): GitHubReleaseAsset {
  return { name, url: apiUrl, browser_download_url: browserUrl };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function updateInfo(overrides: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    version: "0.1.30",
    notes: null,
    publishedAt: null,
    assetName: "milim_0.1.30_x64-portable.exe",
    downloadUrl: "https://example.test/milim_0.1.30_x64-portable.exe",
    checksumUrl: "https://example.test/milim_0.1.30_x64-portable.exe.sha256",
    ...overrides,
  };
}

function createDownloadServices(os: string, checksumText: string, events: string[]): UpdateDownloadServices {
  return {
    downloadBinary: async (url) => {
      events.push(`download:${url}`);
      return UPDATE_BYTES;
    },
    fetchText: async (url) => {
      events.push(`checksum:${url}`);
      return checksumText;
    },
    getPlatform: async () => {
      events.push("platform");
      return os;
    },
    writeUpdateFile: async (fileName, contents) => {
      events.push(`write:${fileName}:${contents.length}`);
      return `C:/Users/USER/AppData/Local/com.omershatz.milim/milim-updates/${fileName}`;
    },
    extractAppZip: async (zipPath) => {
      events.push(`extract:${zipPath}`);
      return `${zipPath}/milim.app`;
    },
  };
}

deepEqual(
  { name: getAssetConfigForPlatform("darwin").name, extension: getAssetConfigForPlatform("darwin").extension },
  { name: "milim.app.zip", extension: ".app.zip" },
);
equal(getAssetConfigForPlatform("win32").extension, ".exe");
throws(() => getAssetConfigForPlatform("linux"), /not supported/);
equal(getUpdateFileName(updateInfo(), "win32"), "milim-0.1.30.exe");
equal(getUpdateFileName(updateInfo(), "darwin"), "milim-0.1.30.app.zip");

equal(compareVersions("v0.1.30", "0.1.29"), 1);
equal(compareVersions("0.1.29-beta.1", "0.1.29"), 0);
equal(compareVersions("0.1.28", "0.1.29"), -1);

equal(shouldRunAutoUpdateCheck(null, 10), true);
equal(shouldRunAutoUpdateCheck(10, 10 + AUTO_UPDATE_INTERVAL_MS - 1), false);
equal(shouldRunAutoUpdateCheck(10, 10 + AUTO_UPDATE_INTERVAL_MS), true);
equal(updateStoreSource.includes("if (get().currentVersion) return;"), false, "current app version should refresh from Tauri on launch");
equal(updateStoreSource.includes("currentVersion: state.currentVersion"), false, "current app version should not persist across installed binaries");

const windowsSelected = selectUpdateAssets(
  [
    asset("milim_0.1.30_x64-portable.exe"),
    asset("SHA256SUMS.txt"),
    asset("milim_0.1.30_x64-portable.exe.sha256"),
  ],
  getAssetConfigForPlatform("win32"),
);
equal(windowsSelected.asset.name, "milim_0.1.30_x64-portable.exe");
equal(windowsSelected.checksumAsset.name, "milim_0.1.30_x64-portable.exe.sha256");

const macSelected = selectUpdateAssets([asset("milim.app.zip"), asset("SHA256SUMS.txt")], getAssetConfigForPlatform("darwin"));
equal(macSelected.asset.name, "milim.app.zip");
equal(macSelected.checksumAsset.name, "SHA256SUMS.txt");

equal(getAssetDownloadUrl(asset("milim.app.zip")), "https://api.github.com/repos/oshtz/milim/releases/assets/milim.app.zip");
equal(parseExpectedSha256(`${SHA_A}  milim_0.1.30_x64-portable.exe`, "milim_0.1.30_x64-portable.exe"), SHA_A);
equal(parseExpectedSha256(`${SHA_A}  other.zip\n${SHA_B}  bundle/macos/milim.app.zip`, "milim.app.zip"), SHA_B);

const hash = await sha256(UPDATE_BYTES);
await verifyChecksum(UPDATE_BYTES, `${hash}  milim_0.1.30_x64-portable.exe`, "milim_0.1.30_x64-portable.exe");
await rejects(
  verifyChecksum(UPDATE_BYTES, `${SHA_A}  milim_0.1.30_x64-portable.exe`, "milim_0.1.30_x64-portable.exe"),
  /Update checksum mismatch/,
);

const events: string[] = [];
const downloaded = await downloadUpdateWithServices(
  updateInfo(),
  createDownloadServices("win32", `${hash}  milim_0.1.30_x64-portable.exe`, events),
);
equal(downloaded.endsWith("milim-0.1.30.exe"), true);
deepEqual(events, [
  "download:https://example.test/milim_0.1.30_x64-portable.exe",
  "checksum:https://example.test/milim_0.1.30_x64-portable.exe.sha256",
  "platform",
  "write:milim-0.1.30.exe:12",
]);

const macEvents: string[] = [];
await downloadUpdateWithServices(
  updateInfo({
    assetName: "milim.app.zip",
    downloadUrl: "https://example.test/milim.app.zip",
    checksumUrl: "https://example.test/milim.app.zip.sha256",
  }),
  createDownloadServices("darwin", `${hash}  milim.app.zip`, macEvents),
);
equal(macEvents.at(-1)?.includes("extract:"), true);

const failedEvents: string[] = [];
await rejects(
  downloadUpdateWithServices(
    updateInfo(),
    createDownloadServices("win32", `${SHA_A}  milim_0.1.30_x64-portable.exe`, failedEvents),
  ),
  /Update checksum mismatch/,
);
deepEqual(failedEvents, [
  "download:https://example.test/milim_0.1.30_x64-portable.exe",
  "checksum:https://example.test/milim_0.1.30_x64-portable.exe.sha256",
]);
