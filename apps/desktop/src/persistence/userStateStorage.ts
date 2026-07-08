import { invoke } from "@tauri-apps/api/core";
import type { StateStorage } from "zustand/middleware";
import { incrementPerfCounter, recordPerfMeasure } from "../lib/perf.js";

const CANONICAL_USER_STATE_KEYS = [
  "milim.sessions",
  "milim.settings",
  "milim.ui",
  "milim.onboarding",
  "milim.themeId",
  "milim.customThemes",
  "milim.window.alwaysOnTop",
  "milim.mobile.urlBase",
  "milim.sessionDrafts",
] as const;

const SYNCED_SETTINGS_KEY = "milim.settings";
const SESSIONS_KEY = "milim.sessions";
const THEME_ID_KEY = "milim.themeId";
const MOBILE_URL_BASE_KEY = "milim.mobile.urlBase";
const SECRET_SETTINGS_FIELDS = ["openAiApiKey", "ttsOpenAiApiKey"] as const;
const DEFERRED_WRITE_DELAY_MS = 150;
const DEFERRED_WRITE_MAX_LATENCY_MS = 3_000;
const FLUSH_USER_STATE_EVENT = "milim://flush-user-state";
const FLUSH_USER_STATE_AND_EXIT_EVENT = "milim://flush-user-state-and-exit";

type UserStateKey = (typeof CANONICAL_USER_STATE_KEYS)[number] | (string & {});
type InvokeFn = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
type TestGlobal = typeof globalThis & {
  __MILIM_TEST_INVOKE__?: InvokeFn;
  __MILIM_TEST_DEFERRED_WRITE_DELAY_MS__?: number;
  __MILIM_TEST_DEFERRED_WRITE_MAX_LATENCY_MS__?: number;
};

const memoryStorage = new Map<string, string>();
const lastWrittenValues = new Map<string, string>();
let legacyImportPromise: Promise<void> | null = null;

type DeferredWrite = {
  value: string;
  timer: ReturnType<typeof setTimeout> | null;
  maxTimer: ReturnType<typeof setTimeout> | null;
  resolve: Array<() => void>;
  reject: Array<(error: unknown) => void>;
};

const deferredWrites = new Map<string, DeferredWrite>();
let lifecycleFlushHandlersInstalled = false;

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function getLocalStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined"
      ? null
      : globalThis.localStorage;
  } catch {
    return null;
  }
}

function localGetItem(key: string): string | null {
  const storage = getLocalStorage();
  return storage ? storage.getItem(key) : (memoryStorage.get(key) ?? null);
}

function localSetItem(key: string, value: string): void {
  const storage = getLocalStorage();
  if (storage) {
    storage.setItem(key, value);
  } else {
    memoryStorage.set(key, value);
  }
}

function localRemoveItem(key: string): void {
  const storage = getLocalStorage();
  if (storage) {
    storage.removeItem(key);
  } else {
    memoryStorage.delete(key);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sanitizeSyncedSettings(value: string): string {
  try {
    const parsed = JSON.parse(value);
    const root = asRecord(parsed);
    const state = asRecord(root?.state);
    const voice = asRecord(state?.voice);
    if (!voice) return value;

    let changed = false;
    for (const field of SECRET_SETTINGS_FIELDS) {
      if (voice[field] !== undefined && voice[field] !== "") {
        voice[field] = "";
        changed = true;
      }
    }
    return changed ? JSON.stringify(parsed) : value;
  } catch {
    return value;
  }
}

function sanitizeThemeId(value: string): string {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string"
      ? JSON.stringify(parsed)
      : JSON.stringify(String(parsed ?? ""));
  } catch {
    return JSON.stringify(value);
  }
}

function sanitizeJsonString(value: string): string {
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(
      typeof parsed === "string" ? parsed : String(parsed ?? ""),
    );
  } catch {
    return JSON.stringify(value);
  }
}

function readJsonString(value: string): string {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : String(parsed ?? "");
  } catch {
    return value;
  }
}

function sanitizeUserStateValue(
  key: string,
  value: string | null,
): string | null {
  if (value === null) return null;
  if (key === THEME_ID_KEY) return sanitizeThemeId(value);
  if (key === MOBILE_URL_BASE_KEY) return sanitizeJsonString(value);
  return key === SYNCED_SETTINGS_KEY ? sanitizeSyncedSettings(value) : value;
}

function userStateReadValue(key: string, value: string): string {
  return key === MOBILE_URL_BASE_KEY ? readJsonString(value) : value;
}

async function invokeUserState<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const testInvoke = (globalThis as TestGlobal).__MILIM_TEST_INVOKE__;
  if (testInvoke) return testInvoke<T>(command, args);
  return invoke<T>(command, args);
}

function stateGetCommand(key: string): {
  command: string;
  args?: Record<string, unknown>;
} {
  return key === SESSIONS_KEY
    ? { command: "user_sessions_get" }
    : { command: "user_state_get", args: { key } };
}

function stateSetCommand(
  key: string,
  value: string,
): { command: string; args?: Record<string, unknown> } {
  return key === SESSIONS_KEY
    ? { command: "user_sessions_set", args: { value } }
    : { command: "user_state_set", args: { key, value } };
}

function stateDeleteCommand(key: string): {
  command: string;
  args?: Record<string, unknown>;
} {
  return key === SESSIONS_KEY
    ? { command: "user_sessions_delete" }
    : { command: "user_state_delete", args: { key } };
}

function shouldDeferWrite(key: string): boolean {
  return key === SESSIONS_KEY;
}

function deferredWriteDelayMs(): number {
  const override = (globalThis as TestGlobal)
    .__MILIM_TEST_DEFERRED_WRITE_DELAY_MS__;
  return typeof override === "number" &&
    Number.isFinite(override) &&
    override >= 0
    ? override
    : DEFERRED_WRITE_DELAY_MS;
}

function deferredWriteMaxLatencyMs(): number {
  const override = (globalThis as TestGlobal)
    .__MILIM_TEST_DEFERRED_WRITE_MAX_LATENCY_MS__;
  return typeof override === "number" &&
    Number.isFinite(override) &&
    override >= 0
    ? override
    : DEFERRED_WRITE_MAX_LATENCY_MS;
}

async function flushDeferredWrite(key: string): Promise<void> {
  const entry = deferredWrites.get(key);
  if (!entry) return;
  deferredWrites.delete(key);
  if (entry.timer != null) clearTimeout(entry.timer);
  if (entry.maxTimer != null) clearTimeout(entry.maxTimer);
  entry.timer = null;
  entry.maxTimer = null;

  const hadPrevious = lastWrittenValues.has(key);
  const previousValue = lastWrittenValues.get(key);
  lastWrittenValues.set(key, entry.value);
  try {
    incrementPerfCounter(`persist.${key}.flush`);
    const command = stateSetCommand(key, entry.value);
    await invokeUserState<void>(command.command, command.args);
    entry.resolve.forEach((resolve) => resolve());
  } catch (error) {
    if (lastWrittenValues.get(key) === entry.value) {
      if (hadPrevious && previousValue !== undefined)
        lastWrittenValues.set(key, previousValue);
      else lastWrittenValues.delete(key);
    }
    entry.reject.forEach((reject) => reject(error));
  }
}

function cancelDeferredWrite(key: string): void {
  const entry = deferredWrites.get(key);
  if (!entry) return;
  deferredWrites.delete(key);
  if (entry.timer != null) clearTimeout(entry.timer);
  if (entry.maxTimer != null) clearTimeout(entry.maxTimer);
  entry.resolve.forEach((resolve) => resolve());
}

function deferUserStateWrite(key: string, value: string): Promise<void> {
  let entry = deferredWrites.get(key);
  if (!entry) {
    entry = { value, timer: null, maxTimer: null, resolve: [], reject: [] };
    deferredWrites.set(key, entry);
    entry.maxTimer = setTimeout(
      () => void flushDeferredWrite(key),
      deferredWriteMaxLatencyMs(),
    );
  }
  entry.value = value;
  const promise = new Promise<void>((resolve, reject) => {
    entry.resolve.push(resolve);
    entry.reject.push(reject);
  });
  if (entry.timer != null) clearTimeout(entry.timer);
  entry.timer = setTimeout(
    () => void flushDeferredWrite(key),
    deferredWriteDelayMs(),
  );
  return promise;
}

export async function flushDeferredUserStateWrites(
  key?: UserStateKey,
): Promise<void> {
  if (key) {
    await flushDeferredWrite(key);
    return;
  }
  await Promise.all(
    Array.from(deferredWrites.keys()).map((pendingKey) =>
      flushDeferredWrite(pendingKey),
    ),
  );
}

export function installUserStateFlushHandlers(): void {
  if (lifecycleFlushHandlersInstalled || typeof window === "undefined") return;
  lifecycleFlushHandlersInstalled = true;

  const flush = () => {
    void flushDeferredUserStateWrites().catch((error) =>
      console.warn("Failed to flush user state:", error),
    );
  };
  const flushAndExit = () => {
    void flushDeferredUserStateWrites()
      .catch((error) =>
        console.warn("Failed to flush user state before exit:", error),
      )
      .finally(() => {
        if (inTauri())
          void invokeUserState<void>("quit_after_user_state_flush").catch(
            () => {},
          );
      });
  };

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);

  if (inTauri()) {
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        Promise.all([
          listen(FLUSH_USER_STATE_EVENT, flush),
          listen(FLUSH_USER_STATE_AND_EXIT_EVENT, flushAndExit),
        ]),
      )
      .catch(() => {});
  }
}

function legacyEntries(): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const key of CANONICAL_USER_STATE_KEYS) {
    const value = localGetItem(key);
    const sanitized = sanitizeUserStateValue(key, value);
    if (sanitized !== null) entries[key] = sanitized;
  }
  return entries;
}

export function importLegacyLocalStorageOnce(): Promise<void> {
  if (!inTauri()) return Promise.resolve();
  if (!legacyImportPromise) {
    legacyImportPromise = invokeUserState<void>("user_state_import_legacy", {
      entries: legacyEntries(),
    }).catch((error) => {
      legacyImportPromise = null;
      throw error;
    });
  }
  return legacyImportPromise;
}

export function readUserStateKey(
  key: UserStateKey,
): string | null | Promise<string | null> {
  if (!inTauri()) {
    const sanitized = sanitizeUserStateValue(key, localGetItem(key));
    return sanitized === null ? null : userStateReadValue(key, sanitized);
  }
  const pending = deferredWrites.get(key);
  if (pending) return userStateReadValue(key, pending.value);
  return importLegacyLocalStorageOnce().then(async () => {
    const command = stateGetCommand(key);
    const value = await invokeUserState<string | null>(
      command.command,
      command.args,
    );
    let sanitized = sanitizeUserStateValue(key, value);
    if (value !== null && sanitized !== null && sanitized !== value) {
      const setCommand = stateSetCommand(key, sanitized);
      await invokeUserState<void>(setCommand.command, setCommand.args);
    }
    if (sanitized !== null) lastWrittenValues.set(key, sanitized);
    return sanitized === null ? null : userStateReadValue(key, sanitized);
  });
}

export function writeUserStateKey(
  key: UserStateKey,
  value: string,
): void | Promise<void> {
  const sanitized = sanitizeUserStateValue(key, value) ?? value;
  if (!inTauri()) {
    if (localGetItem(key) === sanitized) return undefined;
    incrementPerfCounter(`persist.${key}.write`);
    recordPerfMeasure(`persist.${key}.bytes`, sanitized.length);
    localSetItem(key, sanitized);
    lastWrittenValues.set(key, sanitized);
    return undefined;
  }
  const pending = deferredWrites.get(key);
  if (pending?.value === sanitized || lastWrittenValues.get(key) === sanitized)
    return undefined;
  incrementPerfCounter(`persist.${key}.write`);
  recordPerfMeasure(`persist.${key}.bytes`, sanitized.length);
  if (shouldDeferWrite(key)) {
    return deferUserStateWrite(key, sanitized);
  }
  const command = stateSetCommand(key, sanitized);
  return invokeUserState<void>(command.command, command.args).then(() => {
    lastWrittenValues.set(key, sanitized);
  });
}

export function deleteUserStateKey(key: UserStateKey): void | Promise<boolean> {
  cancelDeferredWrite(key);
  lastWrittenValues.delete(key);
  if (!inTauri()) {
    localRemoveItem(key);
    return undefined;
  }
  const command = stateDeleteCommand(key);
  return invokeUserState<boolean>(command.command, command.args);
}

export const userStateStorage: StateStorage = {
  getItem: readUserStateKey,
  setItem: writeUserStateKey,
  removeItem: deleteUserStateKey,
};
