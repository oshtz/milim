import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import { getCodexRateLimits, isCodexModel } from "../api";
import { readUserStateKey } from "../persistence/userStateStorage.js";
import { useSessions } from "../sessions/store";
import { useUiPreferences } from "../ui/store";
import { codexLimitsFromRateLimitPayload, formatProviderLimits, formatThreadMetricsBreakdown, latestProviderLimits } from "../lib/usageMetrics";
import { Pin } from "./icons";
import { Logo } from "./Logo";
import { WindowControls } from "./WindowControls";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const PINNED_KEY = "milim.window.alwaysOnTop";
const INTERACTIVE_TITLEBAR_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  '[role="button"]',
  "[data-window-drag-ignore]",
].join(",");

export function TopBar() {
  const [pinnedReady, setPinnedReady] = useState(!inTauri);
  const pinned = useUiPreferences((s) => s.windowAlwaysOnTop);
  const setPinned = useUiPreferences((s) => s.setWindowAlwaysOnTop);
  const activeSession = useSessions((s) => s.sessions.find((session) => session.id === s.activeId));
  const threadTitle = activeSession?.title?.trim() || "New chat";
  const modelLabel = activeSession?.settings?.model?.trim() || "No model";
  const threadMetrics = formatThreadMetricsBreakdown(activeSession?.messages ?? []);
  const [codexLimits, setCodexLimits] = useState<ReturnType<typeof latestProviderLimits>>([]);
  const activeModelIsCodex = isCodexModel(modelLabel);
  const latestLimits = latestProviderLimits(activeSession?.messages ?? []);
  const providerLimits = activeModelIsCodex && codexLimits.length ? codexLimits : latestLimits;
  const providerLimitText = formatProviderLimits(providerLimits);

  useEffect(() => {
    if (!inTauri) return;
    let cancelled = false;
    const w = getCurrentWindow();
    void (async () => {
      const stored = (await Promise.resolve(readUserStateKey(PINNED_KEY))) === "true";
      try {
        const current = await w.isAlwaysOnTop();
        if (cancelled) return;
        const next = stored || current || useUiPreferences.getState().windowAlwaysOnTop;
        setPinned(next);
      } catch {
        if (cancelled) return;
        setPinned(stored);
      } finally {
        if (!cancelled) setPinnedReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setPinned]);

  useEffect(() => {
    if (!inTauri || !pinnedReady) return;
    void getCurrentWindow()
      .setAlwaysOnTop(pinned)
      .catch(() => {});
  }, [pinned, pinnedReady]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    async function refreshCodexLimits() {
      try {
        const payload = await getCodexRateLimits();
        if (!cancelled) setCodexLimits(codexLimitsFromRateLimitPayload(payload));
      } catch {
        if (!cancelled) setCodexLimits([]);
      }
    }

    if (activeModelIsCodex) {
      void refreshCodexLimits();
      timer = setInterval(() => void refreshCodexLimits(), 60_000);
    } else {
      setCodexLimits([]);
    }
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [activeModelIsCodex]);

  function toggleAlwaysOnTop() {
    setPinned(!pinned);
  }

  function startWindowDrag(e: MouseEvent<HTMLElement>) {
    if (!inTauri || e.button !== 0) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest(INTERACTIVE_TITLEBAR_SELECTOR)) return;

    e.preventDefault();
    getCurrentWindow()
      .startDragging()
      .catch(() => {});
  }

  return (
    <header className="topbar" data-tauri-drag-region onMouseDown={startWindowDrag}>
      <div className="topbar-side topbar-left" aria-label="Current chat" data-tauri-drag-region>
        <Logo height={18} className="topbar-logo" />
        <span className="topbar-divider" aria-hidden="true" data-tauri-drag-region />
        <span className="topbar-thread" title={threadTitle} data-tauri-drag-region>
          {threadTitle}
        </span>
        <span className="topbar-model" title={`Model: ${modelLabel}`} data-tauri-drag-region>
          {modelLabel}
        </span>
        {threadMetrics.label && (
          <span className="topbar-usage" title={threadMetrics.title ?? undefined} data-tauri-drag-region>
            {threadMetrics.label}
          </span>
        )}
        {providerLimitText && (
          <span className="topbar-limit" title={`Provider limit: ${providerLimitText}`} data-tauri-drag-region>
            {providerLimitText}
          </span>
        )}
      </div>

      <div className="topbar-side topbar-right">
        <button
          type="button"
          className={"icon-btn" + (pinned ? " active" : "")}
          data-testid="pin-window"
          title={pinned ? "Keep on top: on" : "Keep on top"}
          aria-label={pinned ? "Disable keep on top" : "Enable keep on top"}
          aria-pressed={pinned}
          onClick={toggleAlwaysOnTop}
        >
          <Pin size={15} />
        </button>
        <WindowControls />
      </div>
    </header>
  );
}
