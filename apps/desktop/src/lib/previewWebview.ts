import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const PREVIEW_WEBVIEW_NAVIGATION_EVENT =
  "milim://preview-webview-navigation";

export type PreviewWebviewLoadState =
  | "navigated"
  | "loading"
  | "ready"
  | "error";

export interface PreviewWebviewNavigation {
  label: string;
  url: string;
  state: PreviewWebviewLoadState;
  message?: string;
}

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function navigatePreviewWebview(
  label: string,
  url: string,
): Promise<void> {
  if (!IS_TAURI) return;
  await invoke("preview_webview_navigate", { label, url });
}

export async function reloadPreviewWebview(label: string): Promise<void> {
  if (!IS_TAURI) return;
  await invoke("preview_webview_reload", { label });
}

export async function movePreviewWebviewHistory(
  label: string,
  delta: -1 | 1,
): Promise<void> {
  if (!IS_TAURI) return;
  await invoke("preview_webview_history", { label, delta });
}

export async function currentPreviewWebviewUrl(
  label: string,
): Promise<string | null> {
  if (!IS_TAURI) return null;
  return await invoke<string>("preview_webview_url", { label });
}

export async function listenForPreviewWebviewNavigation(
  handler: (navigation: PreviewWebviewNavigation) => void,
): Promise<UnlistenFn> {
  if (!IS_TAURI) return () => undefined;
  return await listen<PreviewWebviewNavigation>(
    PREVIEW_WEBVIEW_NAVIGATION_EVENT,
    (event) => handler(event.payload),
  );
}
