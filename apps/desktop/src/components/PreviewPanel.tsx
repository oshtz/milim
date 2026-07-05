import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent, type ReactNode } from "react";
import { openExternalUrl, setActivePreviewTarget, type ChatArtifact, type PreviewAppStatus } from "../api";
import type { ArtifactRevision, ArtifactRevisionGroup } from "../lib/artifactRevisions";
import { buildArtifactPreviewDocument, previewKindForArtifact } from "../lib/artifactPreview";
import { isFileArtifact, normalizeArtifactBrowserUrl } from "../lib/artifacts";
import type { PreviewControlActivity } from "../lib/previewActivity";
import { useContextMenu } from "./ContextMenu";
import { ArrowLeft, ArrowRight, Bolt, Code, Copy, Download, Eye, FileText, Globe, Plus, Refresh, X } from "./icons";
import { Logo } from "./Logo";

const Markdown = lazy(() => import("./Markdown").then((mod) => ({ default: mod.Markdown })));

type PreviewTab = "preview" | "code";
type PreviewLogLevel = "log" | "info" | "warn" | "error";
type NativeWebviewHandle = {
  label: string;
  close: () => Promise<void>;
  hide: () => Promise<void>;
  show: () => Promise<void>;
  once: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
  setPosition: (position: unknown) => Promise<void>;
  setSize: (size: unknown) => Promise<void>;
};

type PreviewControlOverlayPayload = {
  id: string;
  gesture: PreviewControlActivity["gesture"];
  label: string;
  status: PreviewControlActivity["status"];
  dark: boolean;
  accent?: string;
  accentLight?: string;
  accentGlow?: string;
  focusBorder?: string;
};

type PreviewLogEntry = {
  id: number;
  level: PreviewLogLevel;
  label?: string;
  message: string;
  timestamp: number;
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
};

const PREVIEW_LOG_EVENT = "milim-artifact-log";
const MAX_PREVIEW_LOGS = 200;
const LOG_DRAWER_MIN_HEIGHT = 48;
const LOG_DRAWER_DEFAULT_HEIGHT = 142;
const LOG_DRAWER_MAX_HEIGHT = 360;
const LOG_DRAWER_KEYBOARD_STEP = 24;
const CODE_SPLIT_MIN_WIDTH = 132;
const CODE_SPLIT_DEFAULT_WIDTH = 180;
const CODE_SPLIT_MIN_CODE_WIDTH = 160;
const CODE_SPLIT_KEYBOARD_STEP = 24;
const PREVIEW_CONTROL_OVERLAY_CLOSE_MS = 3400;
const PREVIEW_CONTROL_OVERLAY_STORAGE_PREFIX = "milim-preview-control-activity:";
const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const APP_FLOATING_UI_SELECTOR = '[role="dialog"][aria-modal="true"], [role="menu"]';

export function nativePreviewBlockedByAppUi(root: Pick<ParentNode, "querySelector"> = document): boolean {
  return Boolean(root.querySelector(APP_FLOATING_UI_SELECTOR));
}

export function PreviewPanel({
  artifact,
  artifacts,
  revision,
  revisionGroup,
  closing = false,
  noEnterMotion = false,
  previewDeferred = false,
  activeTab: controlledActiveTab,
  onClose,
  onSelectRevision,
  onOpenBrowser,
  onSendArtifactFixPrompt,
  onActiveTabChange,
  runtimeStatus,
  runtimeBusy = false,
  onRuntimeStart,
  onRuntimeStop,
  onRuntimeRestart,
  controlActivity,
  modeSwitcher,
  style,
}: {
  artifact: ChatArtifact;
  artifacts?: readonly ChatArtifact[];
  revision?: ArtifactRevision;
  revisionGroup?: ArtifactRevisionGroup;
  closing?: boolean;
  noEnterMotion?: boolean;
  previewDeferred?: boolean;
  activeTab?: PreviewTab;
  onClose: () => void;
  onSelectRevision?: (revision: ArtifactRevision) => void;
  onOpenBrowser?: () => void;
  onSendArtifactFixPrompt?: (prompt: string) => void;
  onActiveTabChange?: (tab: PreviewTab) => void;
  runtimeStatus?: PreviewAppStatus | null;
  runtimeBusy?: boolean;
  onRuntimeStart?: () => void;
  onRuntimeStop?: () => void;
  onRuntimeRestart?: () => void;
  controlActivity?: PreviewControlActivity | null;
  modeSwitcher?: ReactNode;
  style?: CSSProperties;
}) {
  const { openContextMenu } = useContextMenu();
  const [localActiveTab, setLocalActiveTab] = useState<PreviewTab>(previewDeferred ? "code" : "preview");
  const activeTab = controlledActiveTab ?? localActiveTab;
  const [frameKey, setFrameKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [selectedCodeArtifactId, setSelectedCodeArtifactId] = useState(artifact.id);
  const [previewSource, setPreviewSource] = useState(artifact.content);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [logs, setLogs] = useState<PreviewLogEntry[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [runtimeLogsClearedAt, setRuntimeLogsClearedAt] = useState(0);
  const [logDrawerHeight, setLogDrawerHeight] = useState(LOG_DRAWER_DEFAULT_HEIGHT);
  const [codeFileListWidth, setCodeFileListWidth] = useState(CODE_SPLIT_DEFAULT_WIDTH);
  const [codeSplitDragging, setCodeSplitDragging] = useState(false);
  const [logResizing, setLogResizing] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const logIdRef = useRef(0);
  const codePanelRef = useRef<HTMLDivElement | null>(null);
  const codeSourceRef = useRef<HTMLDivElement | null>(null);
  const codeSplitStartRef = useRef<{ clientX: number; width: number } | null>(null);
  const logResizeStartRef = useRef<{ clientY: number; height: number } | null>(null);
  const previewWasDeferredRef = useRef(previewDeferred);
  const title = artifact.filename ?? artifact.title;
  const source = useMemo(() => artifact.content, [artifact.content]);
  const isUrlPreview = artifact.mime === "text/uri-list";
  const previewUrl = isUrlPreview ? normalizeArtifactBrowserUrl(source) : null;
  const previewKind = isUrlPreview ? "html" : previewKindForArtifact(artifact);
  const [browserUrl, setBrowserUrl] = useState<string | null>(previewUrl);
  const [browserInput, setBrowserInput] = useState(previewUrl ?? "");
  const [browserHistory, setBrowserHistory] = useState<string[]>(() => previewUrl ? [previewUrl] : []);
  const [browserHistoryIndex, setBrowserHistoryIndex] = useState(() => previewUrl ? 0 : -1);
  const [browserError, setBrowserError] = useState<string | null>(null);
  const artifactContext = useMemo(() => (artifacts?.length ? artifacts : [artifact]), [artifact, artifacts]);
  const codeFiles = useMemo(
    () => artifactContext.map((item) => ({ artifact: item, path: artifactLabel(item), entry: item.id === artifact.id })),
    [artifact.id, artifactContext],
  );
  const selectedCodeFile = codeFiles.find((file) => file.artifact.id === selectedCodeArtifactId) ?? codeFiles.find((file) => file.entry) ?? codeFiles[0];
  const selectedCodeArtifact = selectedCodeFile?.artifact ?? artifact;
  const selectedSource = selectedCodeArtifact.content;
  const codeLines = useMemo(() => selectedSource.split("\n"), [selectedSource]);
  const runtimeLogs = useMemo(
    () => (runtimeStatus?.logs ?? []).filter((log) => log.ts > runtimeLogsClearedAt).slice(-MAX_PREVIEW_LOGS).map((log, index): PreviewLogEntry => ({
      id: -index - 1,
      level: log.stream === "stderr" ? "error" : log.stream === "system" ? "info" : "log",
      label: log.stream,
      message: log.line,
      timestamp: log.ts,
    })),
    [runtimeLogsClearedAt, runtimeStatus?.logs],
  );
  const visibleLogs = useMemo(() => [...logs, ...runtimeLogs].slice(-MAX_PREVIEW_LOGS), [logs, runtimeLogs]);
  const errorLogs = logs.filter((log) => log.level === "error");
  const canQuickFix = Boolean(!isUrlPreview && onSendArtifactFixPrompt && (previewError || errorLogs.length));
  const canSwitchRevisions = Boolean(revision && revisionGroup && revisionGroup.revisions.length > 1 && onSelectRevision);
  const codePanelStyle = {
    "--preview-file-list-width": `${codeFileListWidth}px`,
  } as CSSProperties;
  const canGoBack = isUrlPreview && browserHistoryIndex > 0;
  const canGoForward = isUrlPreview && browserHistoryIndex >= 0 && browserHistoryIndex < browserHistory.length - 1;

  function setActiveTab(tab: PreviewTab) {
    if (controlledActiveTab === undefined) setLocalActiveTab(tab);
    if (tab !== activeTab) onActiveTabChange?.(tab);
  }

  useEffect(() => {
    setSelectedCodeArtifactId(artifact.id);
  }, [artifact.id]);

  useEffect(() => {
    if (!isUrlPreview) return;
    setBrowserUrl(previewUrl);
    setBrowserInput(previewUrl ?? "");
    setBrowserHistory(previewUrl ? [previewUrl] : []);
    setBrowserHistoryIndex(previewUrl ? 0 : -1);
    setBrowserError(null);
  }, [artifact.id, isUrlPreview, previewUrl]);

  useEffect(() => {
    if (isUrlPreview && activeTab !== "preview") setActiveTab("preview");
  }, [activeTab, isUrlPreview]);

  useEffect(() => {
    if (!isUrlPreview && previewDeferred && activeTab === "preview") setActiveTab("code");
  }, [activeTab, isUrlPreview, previewDeferred]);

  useEffect(() => {
    if (previewWasDeferredRef.current && !previewDeferred) setActiveTab("preview");
    previewWasDeferredRef.current = previewDeferred;
  }, [previewDeferred]);

  useEffect(() => {
    if (codeFiles.length && !codeFiles.some((file) => file.artifact.id === selectedCodeArtifactId)) {
      setSelectedCodeArtifactId(codeFiles[0].artifact.id);
    }
  }, [codeFiles, selectedCodeArtifactId]);

  useEffect(() => {
    const sourceEl = codeSourceRef.current;
    if (previewDeferred && activeTab === "code" && sourceEl) sourceEl.scrollTo({ top: sourceEl.scrollHeight });
  }, [activeTab, previewDeferred, selectedSource]);

  useEffect(() => {
    if (previewDeferred) return;
    let cancelled = false;
    setPreviewError(null);
    if (isUrlPreview) {
      setPreviewSource(browserUrl ?? "");
      return () => {
        cancelled = true;
      };
    }
    if (previewKind === "markdown") {
      setPreviewSource(source);
      return () => {
        cancelled = true;
      };
    }
    void buildArtifactPreviewDocument(artifact, artifactContext)
      .then((document) => {
        if (cancelled) return;
        setPreviewSource(document.source);
      })
      .catch((e) => {
        if (cancelled) return;
        setPreviewSource(source);
        setPreviewError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [artifact, artifactContext, browserUrl, isUrlPreview, previewDeferred, previewKind, source]);

  useEffect(() => {
    setLogs([]);
    setLogsOpen(false);
  }, [artifact.id, browserUrl, frameKey, source]);

  useEffect(() => {
    if (runtimeStatus?.status === "error") setLogsOpen(true);
  }, [runtimeStatus?.status]);

  useEffect(() => {
    if (isUrlPreview || activeTab !== "preview" || previewDeferred || previewError) return;
    void setActivePreviewTarget({ label: "main", url: title, native: false }).catch(() => undefined);
    return () => {
      void setActivePreviewTarget(null).catch(() => undefined);
    };
  }, [activeTab, frameKey, isUrlPreview, previewDeferred, previewError, title]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const entry = normalizePreviewLog(event.data, ++logIdRef.current);
      if (!entry) return;
      setLogs((current) => [...current, entry].slice(-MAX_PREVIEW_LOGS));
      if (entry.level === "error") setLogsOpen(true);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function copySource() {
    await navigator.clipboard?.writeText(isUrlPreview ? browserUrl ?? browserInput : activeTab === "code" ? selectedSource : source);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  function downloadSource() {
    const currentArtifact = activeTab === "code" ? selectedCodeArtifact : artifact;
    const blob = new Blob([currentArtifact.content], { type: currentArtifact.mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = downloadName(currentArtifact);
    link.click();
    URL.revokeObjectURL(url);
  }

  function openBrowserUrl(url: string) {
    setBrowserUrl(url);
    setBrowserInput(url);
    setBrowserError(null);
    const nextHistory = browserHistory.slice(0, Math.max(browserHistoryIndex + 1, 0));
    if (nextHistory[nextHistory.length - 1] !== url) nextHistory.push(url);
    setBrowserHistory(nextHistory);
    setBrowserHistoryIndex(nextHistory.length - 1);
  }

  function submitBrowserUrl(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeArtifactBrowserUrl(browserInput);
    if (!normalized) {
      setBrowserError("Enter a valid HTTPS or local URL.");
      return;
    }
    openBrowserUrl(normalized);
  }

  function navigateBrowser(delta: -1 | 1) {
    const nextIndex = browserHistoryIndex + delta;
    const nextUrl = browserHistory[nextIndex];
    if (!nextUrl) return;
    setBrowserHistoryIndex(nextIndex);
    setBrowserUrl(nextUrl);
    setBrowserInput(nextUrl);
    setBrowserError(null);
  }

  function blankBrowser() {
    setBrowserUrl(null);
    setBrowserInput("");
    setBrowserHistoryIndex(browserHistory.length);
    setBrowserError(null);
  }

  function reloadBrowser() {
    if (!browserUrl) return;
    setFrameKey((key) => key + 1);
  }

  function openBrowserUrlExternal() {
    if (!browserUrl) return;
    void openExternalUrl(browserUrl).catch((error) => console.warn("failed to open URL", error));
  }

  function sendQuickFix() {
    if (!onSendArtifactFixPrompt) return;
    onSendArtifactFixPrompt(buildFixPrompt(artifact, codeFiles.map((file) => file.path), previewError, errorLogs));
  }

  function clearLogs() {
    setLogs([]);
    setRuntimeLogsClearedAt((runtimeStatus?.logs ?? []).reduce((latest, log) => Math.max(latest, log.ts), 0));
  }

  function openPreviewContextMenu(event: ReactMouseEvent) {
    openContextMenu(event, [
      ...(!isUrlPreview ? [{
        id: "preview-tab",
        label: "Show preview",
        icon: <Eye size={13} />,
        checked: activeTab === "preview",
        disabled: activeTab === "preview",
        action: () => setActiveTab("preview"),
      }, {
        id: "code-tab",
        label: "Show code",
        icon: <Code size={13} />,
        checked: activeTab === "code",
        disabled: activeTab === "code",
        action: () => setActiveTab("code"),
      }] : []),
      ...(activeTab === "preview" && previewKind === "html" && !isUrlPreview ? [{
        id: "reload-preview",
        label: "Reload preview",
        icon: <Refresh size={13} />,
        separatorBefore: true,
        action: () => setFrameKey((key) => key + 1),
      }] : []),
      ...(!isUrlPreview && onOpenBrowser ? [{
        id: "open-browser-panel",
        label: "Open browser panel",
        icon: <Globe size={13} />,
        separatorBefore: activeTab !== "preview" || previewKind !== "html",
        action: onOpenBrowser,
      }] : []),
      ...(isUrlPreview && browserUrl ? [{
        id: "open-external",
        label: "Open in browser",
        icon: <ArrowRight size={13} />,
        separatorBefore: true,
        action: openBrowserUrlExternal,
      }] : []),
      {
        id: "copy",
        label: isUrlPreview ? "Copy URL" : "Copy source",
        icon: <Copy size={13} />,
        separatorBefore: true,
        action: () => void copySource(),
      },
      ...(!isUrlPreview ? [{
        id: "download",
        label: "Download source",
        icon: <Download size={13} />,
        action: downloadSource,
      }] : []),
      ...(canQuickFix ? [{
        id: "quick-fix",
        label: "Quick Fix",
        icon: <Bolt size={13} />,
        separatorBefore: true,
        action: sendQuickFix,
      }] : []),
      {
        id: "close",
        label: "Close preview",
        icon: <X size={13} />,
        separatorBefore: true,
        action: onClose,
      },
    ], title);
  }

  function maxLogDrawerHeight(): number {
    if (typeof window === "undefined") return LOG_DRAWER_MAX_HEIGHT;
    return Math.max(LOG_DRAWER_MIN_HEIGHT, Math.min(LOG_DRAWER_MAX_HEIGHT, Math.round(window.innerHeight * 0.45)));
  }

  function clampLogDrawerHeight(height: number): number {
    return Math.round(Math.min(Math.max(height, LOG_DRAWER_MIN_HEIGHT), maxLogDrawerHeight()));
  }

  function resizeLogDrawer(height: number) {
    setLogDrawerHeight(clampLogDrawerHeight(height));
  }

  function startLogResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    logResizeStartRef.current = { clientY: event.clientY, height: logDrawerHeight };
    setLogResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveLogResize(event: PointerEvent<HTMLDivElement>) {
    const start = logResizeStartRef.current;
    if (!start) return;
    resizeLogDrawer(start.height + start.clientY - event.clientY);
  }

  function endLogResize(event: PointerEvent<HTMLDivElement>) {
    if (!logResizeStartRef.current) return;
    logResizeStartRef.current = null;
    setLogResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resizeLogDrawerWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      resizeLogDrawer(logDrawerHeight + LOG_DRAWER_KEYBOARD_STEP);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      resizeLogDrawer(logDrawerHeight - LOG_DRAWER_KEYBOARD_STEP);
    } else if (event.key === "Home") {
      event.preventDefault();
      resizeLogDrawer(LOG_DRAWER_MIN_HEIGHT);
    } else if (event.key === "End") {
      event.preventDefault();
      resizeLogDrawer(maxLogDrawerHeight());
    }
  }

  function clampCodeSplitWidth(width: number): number {
    const max = Math.max(CODE_SPLIT_MIN_WIDTH, (codePanelRef.current?.clientWidth ?? CODE_SPLIT_DEFAULT_WIDTH + CODE_SPLIT_MIN_CODE_WIDTH) - CODE_SPLIT_MIN_CODE_WIDTH);
    return Math.round(Math.min(Math.max(width, CODE_SPLIT_MIN_WIDTH), max));
  }

  function resizeCodeSplit(width: number) {
    setCodeFileListWidth(clampCodeSplitWidth(width));
  }

  function startCodeSplitResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    codeSplitStartRef.current = { clientX: event.clientX, width: codeFileListWidth };
    setCodeSplitDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveCodeSplitResize(event: PointerEvent<HTMLDivElement>) {
    const start = codeSplitStartRef.current;
    if (!start) return;
    resizeCodeSplit(start.width + event.clientX - start.clientX);
  }

  function endCodeSplitResize(event: PointerEvent<HTMLDivElement>) {
    if (!codeSplitStartRef.current) return;
    codeSplitStartRef.current = null;
    setCodeSplitDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resizeCodeSplitWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizeCodeSplit(codeFileListWidth - CODE_SPLIT_KEYBOARD_STEP);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      resizeCodeSplit(codeFileListWidth + CODE_SPLIT_KEYBOARD_STEP);
    } else if (event.key === "Home") {
      event.preventDefault();
      resizeCodeSplit(CODE_SPLIT_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      resizeCodeSplit(Number.MAX_SAFE_INTEGER);
    }
  }

  return (
    <aside className={`preview-panel${closing ? " closing" : ""}${noEnterMotion ? " no-enter" : ""}`} data-testid="chat-preview-split" style={style} onContextMenu={openPreviewContextMenu}>
      <div className="preview-toolbar">
        {modeSwitcher}
        {!isUrlPreview && (
          <div className="preview-tabs" role="tablist" aria-label="Preview panel">
            <button
              className={`preview-tab${activeTab === "preview" ? " active" : ""}`}
              data-testid="preview-tab-preview"
              role="tab"
              aria-selected={activeTab === "preview"}
              onClick={() => setActiveTab("preview")}
            >
              <Eye size={13} />
              <span>Preview</span>
            </button>
            <button
              className={`preview-tab${activeTab === "code" ? " active" : ""}`}
              data-testid="preview-tab-code"
              role="tab"
              aria-selected={activeTab === "code"}
              onClick={() => setActiveTab("code")}
            >
              <Code size={13} />
              <span>Code</span>
            </button>
          </div>
        )}
        {canSwitchRevisions && revision && revisionGroup && (
          <label className="preview-revision-control" title={`${revisionGroup.label} revision`}>
            <span>Version</span>
            <select
              data-testid="preview-revision-select"
              aria-label="Artifact revision"
              value={revision.revisionNumber}
              onChange={(event) => {
                const next = revisionGroup.revisions.find((item) => item.revisionNumber === Number(event.currentTarget.value));
                if (next) onSelectRevision?.(next);
              }}
            >
              {revisionGroup.revisions.map((itemRevision) => (
                <option key={itemRevision.revisionNumber} value={itemRevision.revisionNumber}>
                  v{itemRevision.revisionNumber}{itemRevision.revisionNumber === itemRevision.totalRevisions ? " latest" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="preview-actions" aria-label="Preview actions">
          {activeTab === "preview" && previewKind === "html" && !isUrlPreview && (
            <button className="preview-action" title="Reload preview" aria-label="Reload preview" onClick={() => setFrameKey((key) => key + 1)}>
              <Refresh size={14} />
            </button>
          )}
          {!isUrlPreview && onOpenBrowser && (
            <button className="preview-action" data-testid="preview-open-browser" title="Open browser panel" aria-label="Open browser panel" onClick={onOpenBrowser}>
              <Globe size={14} />
            </button>
          )}
          <button className="preview-action" title={copied ? "Copied" : isUrlPreview ? "Copy URL" : "Copy source"} aria-label={copied ? "Copied" : isUrlPreview ? "Copy URL" : "Copy source"} onClick={() => void copySource()}>
            <Copy size={14} />
          </button>
          {!isUrlPreview && (
            <button className="preview-action" title="Download source" aria-label="Download source" onClick={downloadSource}>
              <Download size={14} />
            </button>
          )}
          <button className="preview-action" title="Close preview" aria-label="Close preview" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="preview-tab-panel" role="tabpanel" hidden={activeTab !== "preview"}>
        {previewKind === "markdown" ? (
          <div className="preview-markdown">
            <Suspense fallback={<span className="typing">...</span>}>
              <Markdown content={source} />
            </Suspense>
          </div>
        ) : previewDeferred ? (
          <div className="preview-markdown">
            <span className="typing">Generating...</span>
          </div>
        ) : previewError ? (
          <div className="preview-error" role="alert">
            Preview failed: {previewError}
            {canQuickFix && (
              <button className="preview-quick-fix" data-testid="preview-quick-fix" onClick={sendQuickFix}>
                <Bolt size={13} />
                <span>Quick Fix</span>
              </button>
            )}
          </div>
        ) : (
          <div className="preview-runtime-shell">
            {isUrlPreview ? (
              <>
                <div className="preview-browser-bar" data-testid="preview-browser-bar">
                  <button className="preview-browser-action" title="Back" aria-label="Back" disabled={!canGoBack} onClick={() => navigateBrowser(-1)}>
                    <ArrowLeft size={14} />
                  </button>
                  <button className="preview-browser-action" title="Forward" aria-label="Forward" disabled={!canGoForward} onClick={() => navigateBrowser(1)}>
                    <ArrowRight size={14} />
                  </button>
                  <button className="preview-browser-action" title="Reload" aria-label="Reload" disabled={!browserUrl} onClick={reloadBrowser}>
                    <Refresh size={14} />
                  </button>
                  <button className="preview-browser-action" title="New" aria-label="New blank page" onClick={blankBrowser}>
                    <Plus size={14} />
                  </button>
                  <form className="preview-browser-form" onSubmit={submitBrowserUrl}>
                    <Globe size={14} />
                    <input
                      data-testid="preview-browser-url"
                      value={browserInput}
                      onChange={(event) => {
                        setBrowserInput(event.currentTarget.value);
                        setBrowserError(null);
                      }}
                      placeholder="Enter a URL"
                      aria-label="Preview URL"
                    />
                  </form>
                  {runtimeStatus && (
                    <PreviewRuntimeStatus
                      status={runtimeStatus}
                      busy={runtimeBusy}
                      onStart={onRuntimeStart}
                      onStop={onRuntimeStop}
                      onRestart={onRuntimeRestart}
                    />
                  )}
                  <button className="preview-browser-action" title="Open in browser" aria-label="Open in browser" disabled={!browserUrl} onClick={openBrowserUrlExternal}>
                    <ArrowRight size={14} />
                  </button>
                </div>
                {browserError && <div className="preview-browser-error" role="alert">{browserError}</div>}
                <div className="preview-browser-content">
                  {browserUrl ? (
                    <NativeArtifactBrowser url={browserUrl} frameKey={frameKey} title={title} active={!closing} controlActivity={controlActivity} />
                  ) : (
                    <div className="preview-browser-empty" data-testid="preview-browser-empty">
                      <Logo height={42} className="preview-browser-empty-logo" />
                      <strong>Open a preview URL</strong>
                      <span>
                        Use the address bar for localhost
                        <br />
                        or HTTPS pages.
                      </span>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="preview-frame-host">
                <iframe
                  ref={iframeRef}
                  key={`${artifact.id}:${frameKey}`}
                  className="preview-frame"
                  title={title}
                  sandbox="allow-forms allow-modals allow-popups allow-scripts"
                  referrerPolicy="no-referrer"
                  src="about:blank"
                  srcDoc={previewSource}
                />
                {controlActivity && <PreviewControlOverlay key={controlActivity.id} activity={controlActivity} />}
              </div>
            )}
            <div className={`preview-log-drawer${logsOpen ? " open" : ""}`} data-testid="preview-log-drawer">
              <div className="preview-log-head">
                <button className="preview-log-toggle" data-testid="preview-log-toggle" aria-expanded={logsOpen} onClick={() => setLogsOpen((open) => !open)}>
                  Logs <span>{visibleLogs.length}</span>
                </button>
                <div className="preview-log-actions">
                  {visibleLogs.length > 0 && (
                    <button className="preview-log-clear" data-testid="preview-log-clear" title="Clear logs" aria-label="Clear logs" onClick={clearLogs}>
                      <X size={13} />
                      <span>Clear</span>
                    </button>
                  )}
                  {canQuickFix && (
                    <button className="preview-quick-fix" data-testid="preview-quick-fix" onClick={sendQuickFix}>
                      <Bolt size={13} />
                      <span>Quick Fix</span>
                    </button>
                  )}
                </div>
              </div>
              {logsOpen && (
                <>
                  <div
                    className={`preview-log-resize-handle${logResizing ? " dragging" : ""}`}
                    data-testid="preview-log-resize-handle"
                    role="separator"
                    aria-label="Resize logs"
                    aria-orientation="horizontal"
                    aria-valuemin={LOG_DRAWER_MIN_HEIGHT}
                    aria-valuemax={maxLogDrawerHeight()}
                    aria-valuenow={logDrawerHeight}
                    tabIndex={0}
                    onKeyDown={resizeLogDrawerWithKeyboard}
                    onPointerDown={startLogResize}
                    onPointerMove={moveLogResize}
                    onPointerUp={endLogResize}
                    onPointerCancel={endLogResize}
                  />
                  <div className="preview-log-list" data-testid="preview-log-list" style={{ height: logDrawerHeight }}>
                    {visibleLogs.length ? visibleLogs.map((log) => <PreviewLogRow key={log.id} log={log} />) : <div className="preview-log-empty">No logs</div>}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      <div
        ref={codePanelRef}
        className={`preview-code-panel${codeFiles.length > 1 ? " with-file-list" : ""}`}
        role="tabpanel"
        hidden={activeTab !== "code" || isUrlPreview}
        style={codePanelStyle}
      >
        {codeFiles.length > 1 && (
          <div className="preview-file-list" data-testid="preview-code-file-list" aria-label="Artifact files">
            {codeFiles.map((file) => (
              <button
                key={file.artifact.id}
                className={`preview-file-button${file.artifact.id === selectedCodeArtifact.id ? " active" : ""}`}
                data-testid="preview-code-file"
                title={file.path}
                aria-pressed={file.artifact.id === selectedCodeArtifact.id}
                onClick={() => setSelectedCodeArtifactId(file.artifact.id)}
              >
                <FileText size={13} />
                <span className="preview-file-name">{file.path}</span>
                {file.entry && <span className="preview-file-entry">entry</span>}
              </button>
            ))}
          </div>
        )}
        {codeFiles.length > 1 && (
          <div
            className={`preview-code-resize-handle${codeSplitDragging ? " dragging" : ""}`}
            data-testid="preview-code-resize-handle"
            role="separator"
            aria-label="Resize file list"
            aria-orientation="vertical"
            aria-valuemin={CODE_SPLIT_MIN_WIDTH}
            aria-valuemax={Math.max(CODE_SPLIT_MIN_WIDTH, (codePanelRef.current?.clientWidth ?? CODE_SPLIT_DEFAULT_WIDTH + CODE_SPLIT_MIN_CODE_WIDTH) - CODE_SPLIT_MIN_CODE_WIDTH)}
            aria-valuenow={codeFileListWidth}
            tabIndex={0}
            onKeyDown={resizeCodeSplitWithKeyboard}
            onPointerDown={startCodeSplitResize}
            onPointerMove={moveCodeSplitResize}
            onPointerUp={endCodeSplitResize}
            onPointerCancel={endCodeSplitResize}
          />
        )}
        <div ref={codeSourceRef} className="preview-source" data-testid="preview-code-source">
          {codeLines.map((line, index) => (
            <div className="preview-code-line" key={index}>
              <span className="preview-code-line-number" data-testid="preview-code-line-number">{index + 1}</span>
              <span className="preview-code-text">{line || " "}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

function PreviewControlOverlay({ activity }: { activity: PreviewControlActivity }) {
  const className = `preview-control-overlay ${activity.gesture} ${activity.status}`;
  return (
    <div className={className} data-testid="preview-control-overlay" aria-hidden="true">
      <span className="preview-control-scan" />
      {activity.gesture !== "inspect" && <span className="preview-control-cursor-glow" />}
      {activity.gesture !== "inspect" && (
        <svg className="preview-control-cursor" viewBox="0 0 24 24" fill="none" focusable="false">
          <path
            d="M20.5056 10.7754C21.1225 10.5355 21.431 10.4155 21.5176 10.2459C21.5926 10.099 21.5903 9.92446 21.5115 9.77954C21.4205 9.61226 21.109 9.50044 20.486 9.2768L4.59629 3.5728C4.0866 3.38983 3.83175 3.29835 3.66514 3.35605C3.52029 3.40621 3.40645 3.52004 3.35629 3.6649C3.29859 3.8315 3.39008 4.08635 3.57304 4.59605L9.277 20.4858C9.50064 21.1088 9.61246 21.4203 9.77973 21.5113C9.92465 21.5901 10.0991 21.5924 10.2461 21.5174C10.4157 21.4308 10.5356 21.1223 10.7756 20.5054L13.3724 13.8278C13.4194 13.707 13.4429 13.6466 13.4792 13.5957C13.5114 13.5506 13.5508 13.5112 13.5959 13.479C13.6468 13.4427 13.7072 13.4192 13.828 13.3722L20.5056 10.7754Z"
            fill="var(--preview-control-cursor-fill)"
            stroke="var(--preview-control-cursor-stroke)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {activity.gesture === "click" && <span className="preview-control-click-ring" />}
      {activity.gesture === "scroll" && <span className="preview-control-scroll-cue" />}
      {activity.gesture === "type" && <span className="preview-control-caret" />}
      <span className="preview-control-label">
        <span>{previewControlLabel(activity)}</span>
      </span>
    </div>
  );
}

function previewControlLabel(activity: PreviewControlActivity): string {
  if (activity.gesture === "inspect") return activity.detail || activity.label;
  return activity.label;
}

function PreviewRuntimeStatus({
  status,
  busy,
  onStart,
  onStop,
  onRestart,
}: {
  status: PreviewAppStatus;
  busy: boolean;
  onStart?: () => void;
  onStop?: () => void;
  onRestart?: () => void;
}) {
  const running = Boolean(status.pid) || status.status === "installing" || status.status === "starting" || status.status === "running";
  const statusText = String(status.status);
  return (
    <div className={`preview-managed-runtime ${status.status}`} data-testid="preview-managed-runtime">
      <div className="preview-managed-runtime-head">
        <div className="preview-managed-runtime-copy">
          <span className="preview-managed-runtime-dot" aria-hidden="true" />
          <strong>Runtime</strong>
          <span title={status.cwd}>{statusText}</span>
        </div>
        <div className="preview-managed-runtime-actions">
          <button className="preview-browser-action" data-testid="preview-runtime-start" title="Start runtime" disabled={busy || running || !onStart} onClick={onStart}>
            <Globe size={14} />
          </button>
          <button className="preview-browser-action" data-testid="preview-runtime-stop" title="Stop runtime" disabled={busy || !running || !onStop} onClick={onStop}>
            <X size={14} />
          </button>
          <button className="preview-browser-action" data-testid="preview-runtime-restart" title="Restart runtime" disabled={busy || !onRestart} onClick={onRestart}>
            <Refresh size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}

function NativeArtifactBrowser({ url, frameKey, title, active, controlActivity }: { url: string; frameKey: number; title: string; active: boolean; controlActivity?: PreviewControlActivity | null }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<NativeWebviewHandle | null>(null);
  const overlayWebviewRef = useRef<NativeWebviewHandle | null>(null);
  const labelRef = useRef(`artifact-browser-${Math.random().toString(36).slice(2)}`);
  const overlayLabelRef = useRef(`artifact-overlay-${Math.random().toString(36).slice(2)}`);
  const overlayChannelRef = useRef(`preview-control-overlay-${Math.random().toString(36).slice(2)}`);
  const overlayCleanupRef = useRef<(() => void) | null>(null);
  const overlayCloseTimerRef = useRef<number | null>(null);
  const overlayInstanceRef = useRef(0);
  const [nativeError, setNativeError] = useState<string | null>(null);

  function clearOverlayCloseTimer() {
    if (overlayCloseTimerRef.current === null) return;
    window.clearTimeout(overlayCloseTimerRef.current);
    overlayCloseTimerRef.current = null;
  }

  async function closeOverlayWebview() {
    clearOverlayCloseTimer();
    overlayCleanupRef.current?.();
    overlayCleanupRef.current = null;
    await closeNativeWebview(overlayWebviewRef);
  }

  useEffect(() => {
    if (!active) return;
    if (!IS_TAURI) return;

    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    let appUiObserver: MutationObserver | null = null;
    let unlistenError: (() => void) | null = null;
    let removeLayoutListeners: (() => void) | null = null;
    let raf = 0;
    let nativeHidden = false;

    async function closeWebview() {
      await closeOverlayWebview();
      const webview = webviewRef.current;
      webviewRef.current = null;
      if (webview) {
        await webview.hide().catch(() => undefined);
        await webview.close().catch(() => undefined);
      }
    }

    void (async () => {
      const host = hostRef.current;
      if (!host) return;
      const hostElement = host;
      setNativeError(null);
      await closeWebview();
      if (cancelled) return;

      const [{ Webview }, { getCurrentWindow }, { LogicalPosition, LogicalSize }] = await Promise.all([
        import("@tauri-apps/api/webview"),
        import("@tauri-apps/api/window"),
        import("@tauri-apps/api/dpi"),
      ]);
      if (cancelled) return;

      function bounds() {
        const rect = hostElement.getBoundingClientRect();
        return {
          x: Math.max(0, Math.round(rect.left)),
          y: Math.max(0, Math.round(rect.top)),
          width: Math.max(1, Math.round(rect.width)),
          height: Math.max(1, Math.round(rect.height)),
        };
      }

      async function syncBounds(webview = webviewRef.current) {
        if (!webview || !hostElement.isConnected) return;
        const rect = bounds();
        await Promise.all([
          webview.setPosition(new LogicalPosition(rect.x, rect.y)),
          webview.setSize(new LogicalSize(rect.width, rect.height)),
        ]).catch(() => undefined);
      }

      async function syncAppUiVisibility() {
        const blocked = nativePreviewBlockedByAppUi();
        if (blocked === nativeHidden) return;
        nativeHidden = blocked;
        await Promise.all([
          setNativeWebviewHidden(webviewRef.current, blocked),
          setNativeWebviewHidden(overlayWebviewRef.current, blocked),
        ]);
        if (!blocked) void syncBounds(webviewRef.current);
      }

      const rect = bounds();
      const label = `${labelRef.current}-${frameKey}-${Math.random().toString(36).slice(2)}`;
      const webview = new Webview(getCurrentWindow(), label, {
        url,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        focus: true,
        incognito: true,
        zoomHotkeysEnabled: true,
      }) as NativeWebviewHandle;
      webviewRef.current = webview;
      void setActivePreviewTarget({ label, url, native: true }).catch(() => undefined);
      unlistenError = await webview.once<string>("tauri://error", (event) => {
        if (!cancelled) setNativeError(event.payload || "Could not open this page.");
      });
      if (cancelled) {
        unlistenError?.();
        await closeWebview();
        return;
      }
      await syncBounds(webview);
      await syncAppUiVisibility();
      resizeObserver = new ResizeObserver(() => void syncBounds(webview));
      resizeObserver.observe(hostElement);
      appUiObserver = new MutationObserver(() => void syncAppUiVisibility());
      appUiObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal", "role"] });
      const onWindowLayout = () => void syncBounds(webview);
      window.addEventListener("resize", onWindowLayout);
      window.addEventListener("scroll", onWindowLayout, true);
      removeLayoutListeners = () => {
        window.removeEventListener("resize", onWindowLayout);
        window.removeEventListener("scroll", onWindowLayout, true);
      };
      let frame = 0;
      const syncAnimationFrame = () => {
        void syncBounds(webview);
        frame += 1;
        if (frame < 12 && !cancelled) raf = window.requestAnimationFrame(syncAnimationFrame);
      };
      raf = window.requestAnimationFrame(syncAnimationFrame);
    })()
      .catch((error) => {
        if (!cancelled) setNativeError(error instanceof Error ? error.message : String(error));
      });

    return () => {
      cancelled = true;
      if (raf) window.cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      appUiObserver?.disconnect();
      removeLayoutListeners?.();
      unlistenError?.();
      void setActivePreviewTarget(null).catch(() => undefined);
      void closeWebview();
    };
  }, [active, frameKey, url]);

  useEffect(() => {
    if (!active || !controlActivity || !IS_TAURI) return;
    let cancelled = false;
    const channel = overlayChannelRef.current;
    const payload = previewControlOverlayPayload(controlActivity);

    publishPreviewControlOverlayActivity(channel, payload);
    clearOverlayCloseTimer();
    overlayCloseTimerRef.current = window.setTimeout(() => void closeOverlayWebview(), PREVIEW_CONTROL_OVERLAY_CLOSE_MS);

    void (async () => {
      const host = hostRef.current;
      if (!host) return;
      const hostElement = host;
      const [{ Webview }, { getCurrentWindow }, { LogicalPosition, LogicalSize }] = await Promise.all([
        import("@tauri-apps/api/webview"),
        import("@tauri-apps/api/window"),
        import("@tauri-apps/api/dpi"),
      ]);
      if (cancelled) return;

      async function syncOverlayBounds() {
        if (!overlayWebviewRef.current || !hostElement.isConnected) return;
        const nextRect = nativeBrowserBounds(hostElement);
        await Promise.all([
          overlayWebviewRef.current.setPosition(new LogicalPosition(nextRect.x, nextRect.y)),
          overlayWebviewRef.current.setSize(new LogicalSize(nextRect.width, nextRect.height)),
        ]).catch(() => undefined);
      }

      if (!overlayWebviewRef.current) {
        const rect = nativeBrowserBounds(hostElement);
        const overlayLabel = `${overlayLabelRef.current}-${++overlayInstanceRef.current}`;
        const overlay = new Webview(getCurrentWindow(), overlayLabel, {
          url: previewControlOverlayUrl(channel),
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          transparent: true,
          backgroundColor: [0, 0, 0, 0],
          focus: false,
          dragDropEnabled: false,
        }) as NativeWebviewHandle;
        overlayWebviewRef.current = overlay;
        if (nativePreviewBlockedByAppUi()) await overlay.hide().catch(() => undefined);

        const resizeObserver = new ResizeObserver(() => void syncOverlayBounds());
        resizeObserver.observe(hostElement);
        const onWindowLayout = () => void syncOverlayBounds();
        window.addEventListener("resize", onWindowLayout);
        window.addEventListener("scroll", onWindowLayout, true);
        const publishSoon = [
          window.setTimeout(() => publishPreviewControlOverlayActivity(channel, payload), 80),
          window.setTimeout(() => publishPreviewControlOverlayActivity(channel, payload), 220),
        ];
        overlayCleanupRef.current = () => {
          resizeObserver.disconnect();
          window.removeEventListener("resize", onWindowLayout);
          window.removeEventListener("scroll", onWindowLayout, true);
          for (const timer of publishSoon) window.clearTimeout(timer);
        };
      } else {
        await syncOverlayBounds();
        publishPreviewControlOverlayActivity(channel, payload);
      }
    })()
      .catch(() => {
        if (!cancelled) void closeOverlayWebview();
      });

    return () => {
      cancelled = true;
    };
  }, [active, controlActivity?.id]);

  return (
    <div ref={hostRef} className="preview-native-browser" data-testid="preview-native-browser" aria-label={title}>
      {!IS_TAURI && (
        <iframe
          key={`${url}:${frameKey}`}
          className="preview-frame"
          title={title}
          sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
          referrerPolicy="no-referrer"
          src={url}
        />
      )}
      {nativeError && <div className="preview-native-browser-error" role="alert">{nativeError}</div>}
    </div>
  );
}

async function closeNativeWebview(ref: { current: NativeWebviewHandle | null }) {
  const webview = ref.current;
  ref.current = null;
  if (!webview) return;
  await webview.hide().catch(() => undefined);
  await webview.close().catch(() => undefined);
}

async function setNativeWebviewHidden(webview: NativeWebviewHandle | null, hidden: boolean) {
  if (!webview) return;
  await (hidden ? webview.hide() : webview.show()).catch(() => undefined);
}

function nativeBrowserBounds(host: HTMLElement) {
  const rect = host.getBoundingClientRect();
  return {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.max(1, Math.round(rect.width)),
    height: Math.max(1, Math.round(rect.height)),
  };
}

function previewControlOverlayUrl(channel: string): string {
  const params = new URLSearchParams({ channel });
  return `/preview-control-overlay.html?${params.toString()}`;
}

function previewControlOverlayPayload(activity: PreviewControlActivity): PreviewControlOverlayPayload {
  const payload: PreviewControlOverlayPayload = {
    id: activity.id,
    gesture: activity.gesture,
    status: activity.status,
    label: previewControlLabel(activity),
    dark: typeof document !== "undefined" && document.documentElement.getAttribute("data-dark") === "true",
  };
  const styles = typeof document !== "undefined" ? getComputedStyle(document.documentElement) : null;
  const accent = styles?.getPropertyValue("--accent").trim();
  const accentLight = styles?.getPropertyValue("--accent-light").trim();
  const accentGlow = styles?.getPropertyValue("--accent-glow").trim();
  const focusBorder = styles?.getPropertyValue("--focus-border").trim();
  if (accent) payload.accent = accent;
  if (accentLight) payload.accentLight = accentLight;
  if (accentGlow) payload.accentGlow = accentGlow;
  if (focusBorder) payload.focusBorder = focusBorder;
  return payload;
}

function publishPreviewControlOverlayActivity(channel: string, payload: PreviewControlOverlayPayload) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${PREVIEW_CONTROL_OVERLAY_STORAGE_PREFIX}${channel}`, JSON.stringify(payload));
  } catch {
    // Storage is best-effort; BroadcastChannel is enough when the overlay is already loaded.
  }
  if (!("BroadcastChannel" in window)) return;
  try {
    const broadcast = new BroadcastChannel(channel);
    broadcast.postMessage(payload);
    broadcast.close();
  } catch {
    // The overlay will still read the latest payload from localStorage on load.
  }
}

function PreviewLogRow({ log }: { log: PreviewLogEntry }) {
  const location = !log.label && log.source ? `${basename(log.source)}${log.line ? `:${log.line}` : ""}` : "";
  return (
    <div className={`preview-log-row ${log.level}`} data-testid="preview-log-row">
      <span className="preview-log-level">{log.label ?? log.level}</span>
      <span className="preview-log-message">{log.message}</span>
      {location && <span className="preview-log-location">{location}</span>}
    </div>
  );
}

function normalizePreviewLog(raw: unknown, id: number): PreviewLogEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (data.type !== PREVIEW_LOG_EVENT) return null;
  const level = typeof data.level === "string" && isPreviewLogLevel(data.level) ? data.level : "log";
  const message = typeof data.message === "string" ? data.message : String(data.message ?? "");
  if (!message.trim()) return null;
  return {
    id,
    level,
    message,
    timestamp: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
    stack: typeof data.stack === "string" ? data.stack : undefined,
    source: typeof data.source === "string" ? data.source : undefined,
    line: typeof data.line === "number" ? data.line : undefined,
    column: typeof data.column === "number" ? data.column : undefined,
  };
}

function isPreviewLogLevel(value: string): value is PreviewLogLevel {
  return value === "log" || value === "info" || value === "warn" || value === "error";
}

function buildFixPrompt(artifact: ChatArtifact, files: string[], previewError: string | null, errors: PreviewLogEntry[]): string {
  const details = [
    previewError ? `Preview build error:\n${previewError}` : "",
    errors.slice(-5).map(formatErrorLog).join("\n\n"),
  ].filter(Boolean).join("\n\n");
  return [
    "Please fix the current artifact preview errors.",
    "",
    `Artifact: ${artifactLabel(artifact)}`,
    "Files:",
    ...files.map((file) => `- ${file}`),
    "",
    "Errors:",
    "```",
    details || "No error details were captured.",
    "```",
    "",
    "Return the corrected artifact files as named fenced code blocks.",
  ].join("\n");
}

function formatErrorLog(log: PreviewLogEntry): string {
  const location = log.source ? ` (${basename(log.source)}${log.line ? `:${log.line}` : ""})` : "";
  return `${log.message}${location}${log.stack ? `\n${log.stack}` : ""}`;
}

function artifactLabel(artifact: ChatArtifact): string {
  if (!isFileArtifact(artifact) && !artifact.filename) return "Preview source";
  return artifact.filename ?? artifact.title;
}

function downloadName(artifact: ChatArtifact): string {
  const raw = artifact.filename ?? artifact.title;
  return raw.split(/[\\/]/).pop() || "preview.html";
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
