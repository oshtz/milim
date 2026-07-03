import { lazy, Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { openExternalUrl, type ChatArtifact } from "../api";
import type { ArtifactRevision, ArtifactRevisionGroup } from "../lib/artifactRevisions";
import { buildArtifactPreviewDocument, previewKindForArtifact } from "../lib/artifactPreview";
import { normalizeArtifactBrowserUrl } from "../lib/artifacts";
import { ArrowLeft, ArrowRight, Bolt, Code, Copy, Download, Eye, FileText, Globe, Plus, Refresh, X } from "./icons";
import { Logo } from "./Logo";

const Markdown = lazy(() => import("./Markdown").then((mod) => ({ default: mod.Markdown })));

type PreviewTab = "preview" | "code";
type PreviewLogLevel = "log" | "info" | "warn" | "error";
type NativeWebviewHandle = {
  close: () => Promise<void>;
  once: <T>(event: string, handler: (event: { payload: T }) => void) => Promise<() => void>;
  setPosition: (position: unknown) => Promise<void>;
  setSize: (size: unknown) => Promise<void>;
};

type PreviewLogEntry = {
  id: number;
  level: PreviewLogLevel;
  message: string;
  timestamp: number;
  stack?: string;
  source?: string;
  line?: number;
  column?: number;
};

const PREVIEW_LOG_EVENT = "milim-artifact-log";
const MAX_PREVIEW_LOGS = 200;
const CODE_SPLIT_MIN_WIDTH = 132;
const CODE_SPLIT_DEFAULT_WIDTH = 180;
const CODE_SPLIT_MIN_CODE_WIDTH = 160;
const CODE_SPLIT_KEYBOARD_STEP = 24;
const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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
  onSendArtifactFixPrompt,
  onActiveTabChange,
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
  onSendArtifactFixPrompt?: (prompt: string) => void;
  onActiveTabChange?: (tab: PreviewTab) => void;
  modeSwitcher?: ReactNode;
  style?: CSSProperties;
}) {
  const [localActiveTab, setLocalActiveTab] = useState<PreviewTab>(previewDeferred ? "code" : "preview");
  const activeTab = controlledActiveTab ?? localActiveTab;
  const [frameKey, setFrameKey] = useState(0);
  const [copied, setCopied] = useState(false);
  const [selectedCodeArtifactId, setSelectedCodeArtifactId] = useState(artifact.id);
  const [previewSource, setPreviewSource] = useState(artifact.content);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [logs, setLogs] = useState<PreviewLogEntry[]>([]);
  const [logsOpen, setLogsOpen] = useState(false);
  const [codeFileListWidth, setCodeFileListWidth] = useState(CODE_SPLIT_DEFAULT_WIDTH);
  const [codeSplitDragging, setCodeSplitDragging] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const logIdRef = useRef(0);
  const codePanelRef = useRef<HTMLDivElement | null>(null);
  const codeSourceRef = useRef<HTMLDivElement | null>(null);
  const codeSplitStartRef = useRef<{ clientX: number; width: number } | null>(null);
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
    <aside className={`preview-panel${closing ? " closing" : ""}${noEnterMotion ? " no-enter" : ""}`} data-testid="chat-preview-split" style={style}>
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
                  <button className="preview-browser-action" title="Open in browser" aria-label="Open in browser" disabled={!browserUrl} onClick={openBrowserUrlExternal}>
                    <ArrowRight size={14} />
                  </button>
                </div>
                {browserError && <div className="preview-browser-error" role="alert">{browserError}</div>}
                {browserUrl ? (
                  <NativeArtifactBrowser url={browserUrl} frameKey={frameKey} title={title} active={!closing} />
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
              </>
            ) : (
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
            )}
            <div className={`preview-log-drawer${logsOpen ? " open" : ""}`} data-testid="preview-log-drawer">
              <div className="preview-log-head">
                <button className="preview-log-toggle" data-testid="preview-log-toggle" aria-expanded={logsOpen} onClick={() => setLogsOpen((open) => !open)}>
                  Logs <span>{logs.length}</span>
                </button>
                {canQuickFix && (
                  <button className="preview-quick-fix" data-testid="preview-quick-fix" onClick={sendQuickFix}>
                    <Bolt size={13} />
                    <span>Quick Fix</span>
                  </button>
                )}
              </div>
              {logsOpen && (
                <div className="preview-log-list" data-testid="preview-log-list">
                  {logs.length ? logs.map((log) => <PreviewLogRow key={log.id} log={log} />) : <div className="preview-log-empty">No logs</div>}
                </div>
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

function NativeArtifactBrowser({ url, frameKey, title, active }: { url: string; frameKey: number; title: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<NativeWebviewHandle | null>(null);
  const labelRef = useRef(`artifact-browser-${Math.random().toString(36).slice(2)}`);
  const [nativeError, setNativeError] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    if (!IS_TAURI) return;

    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    let unlistenError: (() => void) | null = null;
    let removeLayoutListeners: (() => void) | null = null;
    let raf = 0;

    async function closeWebview() {
      const webview = webviewRef.current;
      webviewRef.current = null;
      if (webview) await webview.close().catch(() => undefined);
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
      unlistenError = await webview.once<string>("tauri://error", (event) => {
        if (!cancelled) setNativeError(event.payload || "Could not open this page.");
      });
      if (cancelled) {
        unlistenError?.();
        await closeWebview();
        return;
      }
      await syncBounds(webview);
      resizeObserver = new ResizeObserver(() => void syncBounds(webview));
      resizeObserver.observe(hostElement);
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
      removeLayoutListeners?.();
      unlistenError?.();
      void closeWebview();
    };
  }, [active, frameKey, url]);

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

function PreviewLogRow({ log }: { log: PreviewLogEntry }) {
  const location = log.source ? `${basename(log.source)}${log.line ? `:${log.line}` : ""}` : "";
  return (
    <div className={`preview-log-row ${log.level}`} data-testid="preview-log-row">
      <span className="preview-log-level">{log.level}</span>
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
  return artifact.filename ?? artifact.title;
}

function downloadName(artifact: ChatArtifact): string {
  const raw = artifact.filename ?? artifact.title;
  return raw.split(/[\\/]/).pop() || "preview.html";
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
