import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  shouldRunAutoUpdateCheck,
  type UpdateInfo,
} from "./service";

export type UpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "disabled"
  | "error";

interface UpdateState {
  currentVersion: string | null;
  status: UpdateStatus;
  updateInfo: UpdateInfo | null;
  updatePath: string | null;
  error: string | null;
  lastCheckedAt: number | null;
  ignoredVersion: string | null;
  recoveryChecked: boolean;
  loadCurrentVersion: () => Promise<void>;
  checkNow: (options?: { automatic?: boolean }) => Promise<UpdateInfo | null>;
  downloadNow: (info?: UpdateInfo | null) => Promise<string | null>;
  installNow: () => Promise<void>;
  ignoreVersion: (version: string) => void;
}

const LOCAL_UPDATE_STATE_KEY = "milim.local.updates";

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isDevBuild(): boolean {
  return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
}

function getMachineLocalStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Update request failed.";
}

async function readCurrentVersion(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}

async function takeUpdateRecoveryError(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string | null>("take_update_recovery_error");
}

export const useUpdateStore = create<UpdateState>()(
  persist(
    (set, get) => ({
      currentVersion: null,
      status: "idle",
      updateInfo: null,
      updatePath: null,
      error: null,
      lastCheckedAt: null,
      ignoredVersion: null,
      recoveryChecked: false,

      loadCurrentVersion: async () => {
        if (!get().recoveryChecked) {
          try {
            const recoveryError = await takeUpdateRecoveryError();
            if (recoveryError) {
              set({
                status: "error",
                error: recoveryError,
                lastCheckedAt: Date.now(),
                recoveryChecked: true,
              });
            } else {
              set({ recoveryChecked: true });
            }
          } catch {
            set({ recoveryChecked: true });
          }
        }
        const version = await readCurrentVersion();
        if (version) set({ currentVersion: version });
      },

      checkNow: async (options) => {
        await get().loadCurrentVersion();
        if (options?.automatic && !shouldRunAutoUpdateCheck(get().lastCheckedAt)) return null;
        if (!isTauriRuntime()) {
          set({ status: "disabled", error: "Updates are only available in the desktop app.", lastCheckedAt: Date.now() });
          return null;
        }
        if (isDevBuild()) {
          set({ status: "disabled", error: "Updates are disabled in development builds.", lastCheckedAt: Date.now() });
          return null;
        }

        set({ status: "checking", error: null });

        try {
          const info = await checkForUpdate();
          if (!info) {
            set({ status: "up-to-date", updateInfo: null, updatePath: null, lastCheckedAt: Date.now() });
            return null;
          }
          if (options?.automatic && get().ignoredVersion === info.version) {
            set({ status: "available", updateInfo: info, updatePath: null, lastCheckedAt: Date.now() });
            return null;
          }
          set({ status: "available", updateInfo: info, updatePath: null, lastCheckedAt: Date.now() });
          return info;
        } catch (error) {
          set({ status: "error", error: formatError(error), lastCheckedAt: Date.now() });
          return null;
        }
      },

      downloadNow: async (info) => {
        const updateInfo = info ?? get().updateInfo;
        if (!updateInfo) return null;
        if (get().status === "ready" && get().updatePath) return get().updatePath;

        set({ status: "downloading", error: null, updateInfo });
        try {
          const updatePath = await downloadUpdate(updateInfo);
          set({ status: "ready", updatePath, updateInfo, ignoredVersion: null });
          return updatePath;
        } catch (error) {
          set({ status: "error", error: formatError(error) });
          return null;
        }
      },

      installNow: async () => {
        const updatePath = get().updatePath;
        if (!updatePath) {
          set({ status: "error", error: "Update package not downloaded yet." });
          return;
        }
        set({ status: "installing", error: null });
        try {
          await installUpdate(updatePath);
        } catch (error) {
          set({ status: "ready", error: formatError(error) });
        }
      },

      ignoreVersion: (version) => set({ ignoredVersion: version }),
    }),
    {
      name: LOCAL_UPDATE_STATE_KEY,
      storage: createJSONStorage(() => getMachineLocalStorage() ?? localStorage),
      partialize: (state) => ({
        status: state.status,
        updateInfo: state.updateInfo,
        updatePath: state.updatePath,
        error: state.error,
        lastCheckedAt: state.lastCheckedAt,
        ignoredVersion: state.ignoredVersion,
      }),
    },
  ),
);
