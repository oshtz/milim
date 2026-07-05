import { deepEqual, equal, throws } from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AUTO_UPDATE_INTERVAL_MS,
  compareVersions,
  downloadUpdateWithServices,
  getAssetConfigForPlatform,
  getAssetDownloadUrl,
  getUpdateFileName,
  selectUpdateAssets,
  shouldRunAutoUpdateCheck,
  type GitHubReleaseAsset,
  type UpdateDownloadServices,
  type UpdateInfo,
} from "../src/update/service.js";

const SHA_A = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SHA_B = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const updateStoreSource = readFileSync("src/update/store.ts", "utf8");

function asset(
  name: string,
  browserUrl = `https://github.com/oshtz/milim/releases/download/v1/${name}`,
  apiUrl = `https://api.github.com/repos/oshtz/milim/releases/assets/${encodeURIComponent(name)}`,
): GitHubReleaseAsset {
  return { name, url: apiUrl, browser_download_url: browserUrl };
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

function createDownloadServices(os: string, events: string[]): UpdateDownloadServices {
  return {
    getPlatform: async () => {
      events.push("platform");
      return os;
    },
    downloadUpdateFile: async (request) => {
      events.push(`native:${request.fileName}:${request.assetName}:${request.downloadUrl}:${request.checksumUrl}`);
      events.push(`native-checksum:${request.checksumUrl.includes(".sha256") ? SHA_A : SHA_B}`);
      return `C:/Users/USER/AppData/Local/com.omershatz.milim/milim-updates/${request.fileName}`;
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
equal(
  updateStoreSource.includes("isInstalledUpdate(version, get().updateInfo)"),
  true,
  "installed update packages should be cleared after the new binary launches",
);
equal(
  updateStoreSource.includes("compareVersions(currentVersion, updateInfo.version) >= 0"),
  true,
  "stale update packages should be detected by semantic version comparison",
);

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

equal(getAssetDownloadUrl(asset("milim.app.zip")), "https://github.com/oshtz/milim/releases/download/v1/milim.app.zip");
equal(
  getAssetDownloadUrl({ name: "milim.app.zip", url: "https://api.github.com/repos/oshtz/milim/releases/assets/1" }),
  "https://api.github.com/repos/oshtz/milim/releases/assets/1",
);
throws(() => getAssetDownloadUrl({ name: "milim.app.zip" }), /no download URL/);

const events: string[] = [];
const downloaded = await downloadUpdateWithServices(
  updateInfo(),
  createDownloadServices("win32", events),
);
equal(downloaded.endsWith("milim-0.1.30.exe"), true);
deepEqual(events, [
  "platform",
  "native:milim-0.1.30.exe:milim_0.1.30_x64-portable.exe:https://example.test/milim_0.1.30_x64-portable.exe:https://example.test/milim_0.1.30_x64-portable.exe.sha256",
  `native-checksum:${SHA_A}`,
]);

const macEvents: string[] = [];
await downloadUpdateWithServices(
  updateInfo({
    assetName: "milim.app.zip",
    downloadUrl: "https://example.test/milim.app.zip",
    checksumUrl: "https://example.test/milim.app.zip.sha256",
  }),
  createDownloadServices("darwin", macEvents),
);
equal(macEvents.at(-1)?.includes("extract:"), true);
