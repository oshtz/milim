import { getCurrentWindow } from "@tauri-apps/api/window";
import type { MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getCodexRateLimits, isCodexModel } from "../api";
import { readUserStateKey } from "../persistence/userStateStorage.js";
import { useSessions } from "../sessions/store";
import { uiSizeShortcutDelta } from "../ui/shortcuts";
import {
  DEFAULT_UI_SIZE,
  MAX_UI_SIZE,
  MIN_UI_SIZE,
  UI_SIZE_STEP,
  useUiPreferences,
} from "../ui/store";
import { useUpdateStore } from "../update/store";
import { codexLimitsFromRateLimitPayload, formatProviderLimits, formatThreadMetricsBreakdown, latestProviderLimits } from "../lib/usageMetrics";
import { Download, Pin } from "./icons";
import { Logo } from "./Logo";
import { WindowControls } from "./WindowControls";

const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const PINNED_KEY = "milim.window.alwaysOnTop";
const ZOOM_CHIP_IDLE_MS = 4000;
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
  const [zoomChipVisible, setZoomChipVisible] = useState(false);
  const zoomChipTimerRef = useRef<number | null>(null);
  const zoomChipHoveredRef = useRef(false);
  const zoomChipFocusedRef = useRef(false);
  const pinned = useUiPreferences((s) => s.windowAlwaysOnTop);
  const setPinned = useUiPreferences((s) => s.setWindowAlwaysOnTop);
  const uiSize = useUiPreferences((s) => s.uiSize);
  const setUiSize = useUiPreferences((s) => s.setUiSize);
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
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const delta = uiSizeShortcutDelta(event);
      if (!delta) return;
      event.preventDefault();
      changeUiSize(delta * UI_SIZE_STEP);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [setUiSize]);

  useEffect(() => () => clearZoomChipTimer(), []);

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

  function clearZoomChipTimer() {
    if (zoomChipTimerRef.current === null) return;
    window.clearTimeout(zoomChipTimerRef.current);
    zoomChipTimerRef.current = null;
  }

  function scheduleZoomChipDismissal() {
    clearZoomChipTimer();
    if (zoomChipHoveredRef.current || zoomChipFocusedRef.current) return;
    zoomChipTimerRef.current = window.setTimeout(() => {
      setZoomChipVisible(false);
      zoomChipTimerRef.current = null;
    }, ZOOM_CHIP_IDLE_MS);
  }

  function revealZoomChip() {
    setZoomChipVisible(true);
    scheduleZoomChipDismissal();
  }

  function changeUiSize(delta: number) {
    setUiSize(useUiPreferences.getState().uiSize + delta);
    revealZoomChip();
  }

  function resetUiSize() {
    setUiSize(DEFAULT_UI_SIZE);
    revealZoomChip();
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
        {zoomChipVisible && (
          <div
            className="topbar-zoom-chip"
            role="group"
            aria-label="UI zoom controls"
            data-testid="ui-zoom-chip"
            data-window-drag-ignore
            onPointerEnter={() => {
              zoomChipHoveredRef.current = true;
              clearZoomChipTimer();
            }}
            onPointerLeave={() => {
              zoomChipHoveredRef.current = false;
              scheduleZoomChipDismissal();
            }}
            onFocusCapture={() => {
              zoomChipFocusedRef.current = true;
              clearZoomChipTimer();
            }}
            onBlurCapture={(event) => {
              if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
              zoomChipFocusedRef.current = false;
              scheduleZoomChipDismissal();
            }}
          >
            <span className="topbar-zoom-value" data-testid="ui-zoom-value" aria-live="polite">
              {uiSize}%
            </span>
            <button
              type="button"
              className="topbar-zoom-btn"
              data-testid="ui-zoom-decrease"
              title="Zoom out"
              aria-label="Zoom out"
              disabled={uiSize <= MIN_UI_SIZE}
              onClick={() => changeUiSize(-UI_SIZE_STEP)}
            >
              <span aria-hidden="true">−</span>
            </button>
            <button
              type="button"
              className="topbar-zoom-btn"
              data-testid="ui-zoom-increase"
              title="Zoom in"
              aria-label="Zoom in"
              disabled={uiSize >= MAX_UI_SIZE}
              onClick={() => changeUiSize(UI_SIZE_STEP)}
            >
              <span aria-hidden="true">+</span>
            </button>
            <button
              type="button"
              className="topbar-zoom-reset"
              data-testid="ui-zoom-reset"
              disabled={uiSize === DEFAULT_UI_SIZE}
              onClick={resetUiSize}
            >
              Reset
            </button>
          </div>
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
        <div className="git-modal-backdrop" data-native-preview-blocker="true" onMouseDown={(event) => event.target === event.currentTarget && setConfirmingUpdate(false)}>
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
