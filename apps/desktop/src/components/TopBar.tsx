import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { getCodexRateLimits, isCodexModel } from "../api";
import { readUserStateKey } from "../persistence/userStateStorage.js";
import { useSessions } from "../sessions/store";
import { useUiPreferences } from "../ui/store";
import { useUpdateStore } from "../update/store";
import { codexLimitsFromRateLimitPayload, formatProviderLimits, formatThreadMetricsBreakdown, latestProviderLimits } from "../lib/usageMetrics";
import { Download, Pin } from "./icons";
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
  const [updateActionRunning, setUpdateActionRunning] = useState(false);
  const [confirmingUpdate, setConfirmingUpdate] = useState(false);
  const pinned = useUiPreferences((s) => s.windowAlwaysOnTop);
  const setPinned = useUiPreferences((s) => s.setWindowAlwaysOnTop);
  const updateStatus = useUpdateStore((s) => s.status);
  const updateInfo = useUpdateStore((s) => s.updateInfo);
  const downloadNow = useUpdateStore((s) => s.downloadNow);
  const installNow = useUpdateStore((s) => s.installNow);
  const activeSession = useSessions((s) => s.sessions.find((session) => session.id === s.activeId));
  const threadTitle = activeSession?.title?.trim() || "New chat";
  const modelLabel = activeSession?.settings?.model?.trim() || "No model";
  const threadMetrics = formatThreadMetricsBreakdown(activeSession?.messages ?? []);
  const [codexLimits, setCodexLimits] = useState<ReturnType<typeof latestProviderLimits>>([]);
  const activeModelIsCodex = isCodexModel(modelLabel);
  const latestLimits = latestProviderLimits(activeSession?.messages ?? []);
  const providerLimits = activeModelIsCodex && codexLimits.length ? codexLimits : latestLimits;
  const providerLimitText = formatProviderLimits(providerLimits);
  const updateBusy = updateActionRunning || updateStatus === "downloading" || updateStatus === "installing";
  const showUpdateButton = !!updateInfo && (updateStatus === "available" || updateStatus === "ready" || updateBusy);
  const updateVersionLabel = updateInfo ? `v${updateInfo.version.replace(/^v/i, "")}` : "";

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

  function runTopBarUpdate() {
    if (!updateInfo || updateBusy) return;
    setConfirmingUpdate(true);
  }

  async function confirmTopBarUpdate() {
    if (!updateInfo || updateBusy) return;
    setConfirmingUpdate(false);

    setUpdateActionRunning(true);
    try {
      const path = await downloadNow(updateInfo);
      if (path) await installNow();
    } finally {
      setUpdateActionRunning(false);
    }
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
        {showUpdateButton && (
          <button
            type="button"
            className={"topbar-update-btn" + (updateBusy ? " busy" : "")}
            data-testid="topbar-update"
            title={updateBusy ? "Installing update" : `Install milim ${updateVersionLabel}`}
            aria-label={updateBusy ? "Installing update" : `Install milim ${updateVersionLabel}`}
            disabled={updateBusy}
            onClick={() => void runTopBarUpdate()}
          >
            <Download size={14} />
          </button>
        )}
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
      {typeof document !== "undefined" && confirmingUpdate && updateInfo && createPortal(
        <div className="git-modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setConfirmingUpdate(false)}>
          <section className="git-modal update-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="update-confirm-title">
            <div className="git-modal-head">
              <span>
                <Download size={14} />
                <strong id="update-confirm-title">Install update</strong>
              </span>
            </div>
            <p>Install milim {updateVersionLabel}? The app will download the update, close, replace itself, and reopen.</p>
            <div className="update-confirm-actions">
              <button className="btn-ghost" type="button" onClick={() => setConfirmingUpdate(false)}>
                Cancel
              </button>
              <button className="btn-accent" type="button" onClick={() => void confirmTopBarUpdate()}>
                Update now
              </button>
            </div>
          </section>
        </div>,
        document.body,
      )}
    </header>
  );
}
