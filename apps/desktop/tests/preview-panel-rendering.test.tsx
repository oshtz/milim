import { createElement, type ComponentType, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { ChatArtifact, PreviewAppPreflight, PreviewAppStatus, PreviewSurfaceTarget } from "../src/api.js";
import type { ArtifactRevision } from "../src/lib/artifactRevisions.js";
import type { PreviewControlActivity } from "../src/lib/previewActivity.js";
import type { PreviewBrowserSession, PreviewSource, PreviewTab } from "../src/components/PreviewPanel.js";

type PreviewPanelProps = {
  artifact: ChatArtifact;
  artifacts?: readonly ChatArtifact[];
  fixArtifact?: ChatArtifact;
  fixArtifacts?: readonly ChatArtifact[];
  fixRevision?: ArtifactRevision;
  onClose: () => void;
  onOpenBrowser?: () => void;
  onPrepareArtifactFix?: (prompt: string) => void;
  activeTab?: PreviewTab;
  onActiveTabChange?: (tab: PreviewTab) => void;
  previewSource?: PreviewSource;
  availablePreviewSources?: readonly PreviewSource[];
  onPreviewSourceChange?: (source: PreviewSource) => void;
  browserSession?: PreviewBrowserSession;
  onBrowserSessionChange?: (session: PreviewBrowserSession) => void;
  runtimeStatus?: PreviewAppStatus | null;
  runtimePreflight?: PreviewAppPreflight | null;
  onRuntimePreflight?: () => void;
  onRuntimeStart?: () => void;
  modeSwitcher?: ReactNode;
  controlActivity?: PreviewControlActivity | null;
  onSurfaceChange?: (surface: PreviewSurfaceTarget | null) => void;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const urlArtifact: ChatArtifact = {
  id: "url-preview",
  kind: "text",
  title: "http://localhost:5173/",
  mime: "text/uri-list",
  content: "http://localhost:5173/",
  size: 22,
  language: "url",
};

const blankUrlArtifact: ChatArtifact = {
  id: "blank-url-preview",
  kind: "text",
  title: "Browser",
  mime: "text/uri-list",
  content: "",
  size: 0,
  language: "url",
};

const htmlArtifact: ChatArtifact = {
  id: "html-preview",
  kind: "code",
  title: "index.html",
  filename: "index.html",
  language: "html",
  mime: "text/html",
  content: "<!doctype html><html><body>Preview</body></html>",
  size: 48,
};

const textArtifact: ChatArtifact = {
  id: "notes-text",
  kind: "code",
  title: "notes.txt",
  filename: "notes.txt",
  language: "text",
  mime: "text/plain",
  content: "first line\nsecond line",
  size: 22,
};

const runtimePreflight: PreviewAppPreflight = {
  thread_id: "thread-1",
  cwd: "C:\\workspace\\generated-app",
  managed: false,
  scope: "selected_folder",
  package_manager: "pnpm",
  install_required: true,
  install_command: "pnpm install --ignore-scripts",
  dev_command: "pnpm dev -- --host 127.0.0.1 --port 4173",
  source_fingerprint: "0123456789abcdef0123456789abcdef",
  port: 4173,
  url: "http://127.0.0.1:4173/",
};

const runtimeStatus: PreviewAppStatus = {
  thread_id: "thread-1",
  status: "error",
  cwd: runtimePreflight.cwd,
  active: false,
  ready: false,
  managed: false,
  error: { code: "runtime_failed", message: "Compilation failed" },
  message: "The app could not compile.",
  preflight: runtimePreflight,
  logs: [{ seq: 1, ts: 1, stream: "stderr", line: "Unexpected token" }],
};

const controlActivity: PreviewControlActivity = {
  id: "activity-1",
  gesture: "click",
  label: "Used computer",
  status: "done",
};

const server = await createServer({
  root: process.cwd(),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const { PreviewPanel, buildFixPrompt, nativePreviewBlockedByAppUi, previewSurfaceIsInspectable, nextPreviewTab } = await server.ssrLoadModule("/src/components/PreviewPanel.tsx") as {
    PreviewPanel: ComponentType<PreviewPanelProps>;
    buildFixPrompt: (
      artifact: ChatArtifact,
      files: string[],
      revisionNumber: number | undefined,
      previewError: string | null,
      runtimeError: string | null,
      errors: Array<{ id: number; level: "error"; message: string; timestamp: number }>,
    ) => string;
    nativePreviewBlockedByAppUi: (root: Pick<ParentNode, "querySelector">) => boolean;
    previewSurfaceIsInspectable: (surface: PreviewSurfaceTarget | null) => boolean;
    nextPreviewTab: (current: PreviewTab, key: string, tabs: readonly PreviewTab[]) => PreviewTab | null;
  };
  const { ContextMenuProvider } = await server.ssrLoadModule("/src/components/ContextMenu.tsx") as {
    ContextMenuProvider: ComponentType<{ children: ReactNode }>;
  };
  const renderPreviewPanel = (props: PreviewPanelProps) => renderToStaticMarkup(
    createElement(ContextMenuProvider, null, createElement(PreviewPanel, props)),
  );
  assert(nativePreviewBlockedByAppUi({ querySelector: () => ({}) as Element }), "Native preview should hide behind app modal/menu UI");
  assert(!nativePreviewBlockedByAppUi({ querySelector: () => null }), "Native preview should stay visible without blocking app UI");
  assert(previewSurfaceIsInspectable({
    label: "main",
    kind: "artifact_iframe",
    title: "index.html",
    native: false,
    status: "ready",
    capabilities: ["dom_snapshot", "click"],
  }), "Ready DOM-capable artifact surfaces should expose preview tools");
  assert(!previewSurfaceIsInspectable({
    kind: "blank",
    title: "Browser",
    native: false,
    status: "not_inspectable",
    capabilities: [],
  }), "Blank browser surfaces should not expose preview tools");
  assert(!previewSurfaceIsInspectable({
    kind: "markdown",
    title: "notes.md",
    native: false,
    status: "not_inspectable",
    capabilities: ["source"],
  }), "Markdown/code-only surfaces should not expose preview tools");
  assert(nextPreviewTab("preview", "ArrowRight", ["preview", "code"]) === "code", "Right Arrow should advance inspector tabs");
  assert(nextPreviewTab("preview", "ArrowLeft", ["preview", "code"]) === "code", "Left Arrow should wrap inspector tabs");
  assert(nextPreviewTab("code", "Home", ["preview", "code"]) === "preview", "Home should focus the first inspector tab");
  assert(nextPreviewTab("preview", "End", ["preview", "code"]) === "code", "End should focus the last inspector tab");
  const fixPrompt = buildFixPrompt(
    htmlArtifact,
    ["index.html"],
    3,
    null,
    "Compilation failed\nThe app could not compile.",
    [{ id: 1, level: "error", message: "Unexpected token", timestamp: 1 }],
  );
  assert(fixPrompt.includes("Revision: v3"), "Prepare fix should identify the selected revision");
  assert(fixPrompt.includes("Compilation failed"), "Prepare fix should include structured runtime failure details");
  assert(fixPrompt.includes("The app could not compile."), "Prepare fix should include the runtime message");
  assert(fixPrompt.includes("Unexpected token"), "Prepare fix should include recent error logs");

  const urlMarkup = renderPreviewPanel({ artifact: urlArtifact, onClose: () => {} });
  assert(urlMarkup.includes('data-testid="preview-browser-bar"'), "URL artifacts should render browser chrome");
  assert(urlMarkup.includes('data-testid="preview-browser-url"'), "URL artifacts should render an address input");
  assert(urlMarkup.includes('data-testid="preview-native-browser"'), "URL artifacts should render the native browser host");
  assert(urlMarkup.includes('src="http://localhost:5173/"'), "URL artifacts should render a non-Tauri iframe fallback");

  const blankUrlMarkup = renderPreviewPanel({ artifact: blankUrlArtifact, onClose: () => {} });
  assert(blankUrlMarkup.includes('data-testid="preview-browser-bar"'), "Blank URL artifacts should still render browser chrome");
  assert(blankUrlMarkup.includes('data-testid="preview-browser-empty"'), "Blank URL artifacts should render the empty browser state");
  assert(!blankUrlMarkup.includes('data-testid="preview-native-browser"'), "Blank URL artifacts should not render a native browser host");

  const htmlMarkup = renderPreviewPanel({ artifact: htmlArtifact, onClose: () => {}, onOpenBrowser: () => {} });
  assert(!htmlMarkup.includes('data-testid="preview-browser-bar"'), "HTML artifacts should not render browser chrome");
  assert(htmlMarkup.includes('data-testid="preview-open-browser"'), "HTML artifacts should let users switch to the browser");
  assert(htmlMarkup.includes("srcDoc="), "HTML artifacts should keep srcDoc preview rendering");
  assert(!htmlMarkup.includes('data-testid="preview-control-overlay"'), "Preview overlay should not render without activity");
  assert(htmlMarkup.includes('aria-label="Inspector"'), "The side inspector should have an accessible name");
  assert(htmlMarkup.includes('id="inspector-tab-preview"'), "Fallback Preview tab should expose a stable id");
  assert(htmlMarkup.includes('aria-controls="inspector-panel-preview"'), "Preview tab should control its linked panel");
  assert(htmlMarkup.includes('id="inspector-panel-preview"'), "Preview panel should expose the linked id");
  assert(htmlMarkup.includes('aria-labelledby="inspector-tab-preview"'), "Preview panel should be labelled by its tab");
  assert(htmlMarkup.includes('data-testid="preview-context-title"'), "Inspector should render a contextual title row");
  assert(htmlMarkup.includes("index.html"), "Contextual title should include the artifact name");

  const codeMarkup = renderPreviewPanel({ artifact: textArtifact, artifacts: [textArtifact, htmlArtifact], activeTab: "code", onClose: () => {} });
  assert(!codeMarkup.includes('data-testid="preview-tab-preview"'), "Non-renderable artifacts should be code-only");
  assert(codeMarkup.includes('data-testid="preview-tab-code"'), "Code-only artifacts should keep the Code tab");
  assert(codeMarkup.includes('id="inspector-panel-code"'), "Code panel should expose the linked id");
  assert(codeMarkup.includes('aria-labelledby="inspector-tab-code"'), "Code panel should be labelled by its tab");
  assert(codeMarkup.includes('aria-label="Artifact file"'), "Multi-file code should provide a narrow-layout file selector");
  assert(codeMarkup.includes('data-testid="preview-code-line-number" aria-hidden="true"'), "Visual line numbers should be hidden from assistive technology");

  const unifiedTabs = createElement("div", { className: "side-panel-switcher", role: "tablist", "aria-label": "Inspector views" },
    createElement("button", { id: "inspector-tab-preview", role: "tab", "aria-selected": true, "aria-controls": "inspector-panel-preview" }, "Preview"),
    createElement("button", { id: "inspector-tab-code", role: "tab", "aria-selected": false, "aria-controls": "inspector-panel-code" }, "Code"),
  );
  const unifiedMarkup = renderPreviewPanel({ artifact: htmlArtifact, onClose: () => {}, modeSwitcher: unifiedTabs });
  assert((unifiedMarkup.match(/id="inspector-tab-preview"/g) ?? []).length === 1, "Unified mode switcher should replace nested Preview/Code tabs");
  const appCodeMarkup = renderPreviewPanel({
    artifact: htmlArtifact,
    activeTab: "code",
    previewSource: "app",
    availablePreviewSources: ["artifact", "app", "url"],
    runtimeStatus,
    onClose: () => {},
    modeSwitcher: unifiedTabs,
  });
  assert(appCodeMarkup.includes("index.html"), "Code context should keep the selected artifact title");
  assert(!appCodeMarkup.includes('data-testid="preview-source-selector"'), "Preview source controls should not appear in Code");

  const runtimeMarkup = renderPreviewPanel({
    artifact: urlArtifact,
    fixArtifact: htmlArtifact,
    fixArtifacts: [htmlArtifact],
    previewSource: "app",
    availablePreviewSources: ["artifact", "app", "url"],
    runtimeStatus,
    runtimePreflight,
    onRuntimePreflight: () => {},
    onRuntimeStart: () => {},
    onPrepareArtifactFix: () => {},
    onClose: () => {},
  });
  assert(runtimeMarkup.includes('data-testid="preview-source-selector"'), "Multiple preview sources should render a compact selector");
  assert(runtimeMarkup.includes("generated-app"), "App context should use the project folder title");
  assert(runtimeMarkup.includes('data-testid="preview-runtime-preflight-details"'), "Runtime review should show preflight details");
  assert(runtimeMarkup.includes("pnpm install --ignore-scripts"), "Runtime review should show the exact install command");
  assert(runtimeMarkup.includes("may modify the selected folder"), "Selected-folder installs should show a mutation warning");
  assert(runtimeMarkup.includes('aria-label="Run app preview"'), "Runtime should expose an explicit accessible Run action");
  assert(runtimeMarkup.includes('data-testid="preview-prepare-fix"'), "App runtime errors should offer Prepare fix");
  assert(!runtimeMarkup.includes("Quick Fix"), "Legacy Quick Fix copy should be removed");

  const activeMarkup = renderPreviewPanel({ artifact: htmlArtifact, onClose: () => {}, controlActivity });
  assert(activeMarkup.includes('data-testid="preview-control-overlay"'), "Preview overlay should render when activity is supplied");
  assert(activeMarkup.includes('aria-hidden="true"'), "Preview overlay should be hidden from assistive tech");

  const activeUrlMarkup = renderPreviewPanel({ artifact: urlArtifact, onClose: () => {}, controlActivity });
  assert(!activeUrlMarkup.includes('data-testid="preview-control-overlay"'), "URL previews should leave preview control cues to the native overlay window");
} finally {
  await server.close();
}

export {};
