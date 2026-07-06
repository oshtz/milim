import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type SetStateAction,
} from "react";
import { useAgents } from "../agents/store";
import {
  artifactFileStatus,
  claudeRuntimeModel,
  completeChat,
  completeChatWithMetrics,
  codexRuntimeModel,
  inferAttachmentMime,
  generateMedia,
  getClaudeStatus,
  getCodexAccount,
  getWorkspaceGitStatus,
  getMediaModelSchema,
  getMediaStatus,
  getPreviewAppStatus,
  isClaudeModel,
  isCliPathWarningMessage,
  isCodexModel,
  listWorkspaceFiles,
  listModelsDetailed,
  listMediaModels,
  listProviders,
  listSkills,
  MAX_ATTACHMENT_BYTES,
  openArtifactLocation,
  openExternalUrl,
  pollMobileCompanionEvents,
  pollScheduleRunEvents,
  publishMobileThreadSnapshot,
  previewArtifactFile,
  readAttachmentFile,
  restartPreviewApp,
  runWorkspaceGitAction,
  saveArtifactFile,
  searchGraphMemory,
  selectSkills,
  setComputerUse,
  setPrivacyMode,
  setWorkspace,
  speakText,
  stagePreviewApp,
  startPreviewApp,
  stopChildThread,
  stopPreviewApp,
  streamAgentRun,
  streamChat,
  streamChildThreadEvents,
  streamClaudeRun,
  streamCodexDeviceLogin,
  streamCodexRun,
  wireMessageContent,
  mediaProviders,
  type AgentEvent,
  type ArtifactFileStatus,
  type ArtifactOpenTarget,
  type ArtifactWritePreview,
  type ChatArtifact,
  type ChatAttachment,
  type ChatApprovalRequest,
  type ChatMessage,
  type ChatStreamPart,
  type ChildThreadInfo,
  type ClaudeRunEvent,
  type CodexLoginEvent,
  type CodexRunEvent,
  type MediaGenerationResult,
  type MediaKind,
  type MediaModelSchema,
  type MediaSchemaControl,
  type MobileThreadGroup,
  type MobileThreadSummary,
  type MobileRelayAttachment,
  type MobileRelayEvent,
  type MemoryNotice,
  type ModelInfo,
  type PreviewAppFile,
  type PreviewAppStatus,
  type PreviewAppStartOptions,
  type PrivacyMode,
  type ProviderInfo,
  type ReasoningEffort,
  type RunStep,
  type RunTrace,
  type SavedArtifactFile,
  type ScheduleRunEvent,
  type SkillInfo,
  type TokenUsage,
  type ToolApprovalMode,
  type ThreadEvent,
  type WorkspaceFileSuggestion,
  type WorkspaceCheckpoint,
  type WorkspaceGitStatus,
} from "../api";
import {
  DEFAULT_THREAD_SETTINGS,
  normalizeVirtualFilePath,
  sessionVirtualProjectFiles,
  useSessions,
  type Project,
  type QueuedMessage,
  type Session,
  type SessionPreviewRuntime,
  type SessionSidebarState,
  type SessionSidePanelMode,
  type SessionVirtualFile,
} from "../sessions/store";
import {
  artifactPreviewAutoOpenKey,
  extractLivePreviewArtifactFromContent,
  extractLocalhostUrlFromRunTrace,
  hasPreviewPackageJson,
  isPreviewableArtifact,
  previewRuntimeBrowserUrl,
  previewRuntimeFiles,
} from "../lib/artifacts";
import {
  artifactOccurrenceKey,
  artifactRevisionChoiceByOccurrence,
  artifactRevisionGroups,
  type ArtifactRevision,
  type ArtifactRevisionGroup,
} from "../lib/artifactRevisions";
import { hiddenArtifactIdsForMessage } from "../lib/artifactVisibility";
import {
  checkpointMessage,
  compactionSummaryOutputCap,
  compactionSummaryMessages,
  compactionSummaryReasoningEffort,
  estimateMessagesTokens,
  isCompactionCheckpoint,
  messagesForModelContext,
  modelContextBudget,
  splitCompactionTail,
  validateCompactionCheckpointSummary,
} from "../lib/contextCompaction";
import { reasoningEffortForModel } from "../lib/reasoningEffort";
import {
  AI_THREAD_TITLE_SYSTEM_PROMPT,
  isThreadNamingModel,
  sanitizeAiThreadTitle,
  shouldReplaceThreadTitle,
} from "../lib/threadTitles";
import {
  chatExportFilename,
  exportedSessionCandidate,
  markdownSessionCandidate,
  sessionExportPayload,
  sessionMarkdownExport,
  type ThreadExportFormat,
} from "../lib/threadExport";
import {
  DEFAULT_GOAL_SETTINGS,
  applyGoalDecision,
  goalConfigured,
  goalContinuationPrompt,
  goalDecisionMessages,
  normalizeGoalSettings,
  parseGoalDecision,
  type GoalDecision,
  type GoalSettings,
} from "../lib/goals";
import { isNearScrollBottom } from "../lib/scroll";
import {
  bestMediaResultUrl,
  defaultMediaAdvanced,
  defaultMediaModel,
  inputWithSchemaControls,
  mediaKindForModelId,
  mediaPreferenceKey,
  mediaResultContent,
  parseControlValue,
  schemaDefaults,
  shouldPollMediaStatus,
} from "../lib/media";
import {
  estimateResponseCostUsd,
  formatResponseMetrics,
  responseMetricsForTurn,
  summarizeMilimUsage,
  summarizeThreadMetricsBreakdown,
  type MilimUsageSummary,
} from "../lib/usageMetrics";
import { markPerfRender } from "../lib/perf";
import {
  previewControlActivityFromDebugUrl,
  previewControlActivityFromStreamParts,
} from "../lib/previewActivity";
import {
  previewRuntimeFoldersEqual,
  previewRuntimeKeyForThread,
} from "../lib/previewRuntimeKeys";
import { statusPart } from "../lib/turnEvents";
import {
  accountRuntimeNotReadyForTurn,
  appendUserTurn,
  editResendConversation,
  prepareTurnOutbound,
  regenerateTurnConversation,
  resolveTurnSetup,
  type AccountRuntimeReady,
  type PrepareTurnOutboundOptions,
} from "../lib/turnContext";
import {
  prepareTurnPromptContext,
  resolveTurnToolApproval,
} from "../lib/turnPrompt";
import {
  claudeCompactionSummaryRequest,
  codexCompactionSummaryRequest,
  codexPromptFromMessages,
  createAgentRunEventHandler,
  createTurnAssistantStarter,
  createTurnMetricsCapture,
  createTurnRunTraceState,
  finalizeTurnRuntime,
  handleTurnRuntimeError,
  runModelChatTurn,
  runSelectedAccountRuntimeTurn,
  runToolAgentTurn,
} from "../lib/turnRuntime";
import {
  drainQueuedMessages as drainQueuedMessagesFromQueue,
  hasQueuedMessages,
  queuedModelForSession,
} from "../lib/turnQueue";
import {
  claimTurnGeneration,
  releaseTurnGeneration,
  startTurnStream,
} from "../lib/turnStream";
import { checkpointWorkspaceBeforeTurn } from "../lib/turnWorkspace";
import { createChatMessageId } from "../lib/messageIds.js";
import { flushDeferredUserStateWrites } from "../persistence/userStateStorage";
import { useSettings, type MediaSettings } from "../settings/store";
import { themeCssVariables } from "../theme/applyTheme";
import { useTheme } from "../theme/store";
import { featureVisibleInMode, type FeatureId } from "../ui/features";
import { shortcutLabel, shortcutMatchesEvent } from "../ui/shortcuts";
import { useUiPreferences } from "../ui/store";
import { Composer } from "./Composer";
import { ControlBar } from "./ControlBar";
import { GoalPanel, type GoalPanelDraft } from "./GoalPanel";
import {
  ArrowRight,
  Calendar,
  Check,
  Code,
  Copy,
  GitBranch,
  Globe,
  Image,
  Pencil,
  Refresh,
  Sidebar as PanelIcon,
  Trash,
  Volume2,
  X,
} from "./icons";
import { groupSessionsByProjects } from "./Sidebar";
import { InlineMediaControls } from "./InlineMediaControls";
import { AssistantMessage } from "./AssistantMessage";
import { ArtifactList } from "./ArtifactList";
import { ChatSearchPopover } from "./ChatSearchPopover";
import { useContextMenu } from "./ContextMenu";
import { GitWorkspacePanel } from "./GitPanel";
import { PreviewPanel } from "./PreviewPanel";
import { RunTimeline } from "./RunTimeline";

const ProvidersManager = lazy(() =>
  import("./ProvidersManager").then((mod) => ({
    default: mod.ProvidersManager,
  })),
);
const McpManager = lazy(() =>
  import("./McpManager").then((mod) => ({ default: mod.McpManager })),
);
const MemoryManager = lazy(() =>
  import("./MemoryManager").then((mod) => ({ default: mod.MemoryManager })),
);

const TOOL_APPROVAL_ORDER: ToolApprovalMode[] = ["review", "guarded", "open"];

const inTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const EMPTY: ChatMessage[] = [];
const EMPTY_QUEUE: QueuedMessage[] = [];
const NON_EMPTY_USAGE_MESSAGES: ChatMessage[] = [{ role: "user", content: "" }];
const MAX_ATTACHMENT_IMAGE_PREVIEW_BYTES = 2 * 1024 * 1024;
const PREVIEW_PANEL_MIN_WIDTH = 280;

type CompactionSummaryResult = {
  content: string;
  usage?: TokenUsage;
  costUsd?: number;
  finishReason?: string;
};

function mergeTokenUsage(
  left?: TokenUsage,
  right?: TokenUsage,
): TokenUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    prompt_tokens: left.prompt_tokens + right.prompt_tokens,
    completion_tokens: left.completion_tokens + right.completion_tokens,
    total_tokens: left.total_tokens + right.total_tokens,
  };
}

function mobileThreadMessages(
  messages: ChatMessage[],
): { role: string; content: string }[] {
  return messages
    .filter(
      (message) => message.role === "user" || message.role === "assistant",
    )
    .map((message) => ({
      role: message.role,
      content: mobileThreadMessageContent(message),
    }))
    .filter((message) => message.content.trim());
}

function mobileThreadMessageContent(message: ChatMessage): string {
  if (message.content.trim()) return message.content;
  return (message.streamParts ?? [])
    .filter(
      (part): part is Extract<ChatStreamPart, { kind: "text" }> =>
        part.kind === "text",
    )
    .map((part) => part.content)
    .join("");
}

function mobileFolderLabel(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() || folder || "Project";
}

function mobileProjectByFolder(projects: Project[]): Map<string, Project> {
  return new Map(
    projects
      .filter((project) => !project.archivedAt)
      .map((project) => [project.folder, project]),
  );
}

function mobileThreadSummary(
  session: ChatSessionSummary,
  running: Set<string>,
  projectByFolder: Map<string, Project>,
): MobileThreadSummary {
  const folder = session.settings?.folder?.trim() ?? "";
  const project = folder ? projectByFolder.get(folder) : undefined;
  return {
    id: session.id,
    title: session.title || "New chat",
    model: session.model ?? null,
    updated_at: Math.floor(session.updatedAt / 1000),
    busy: running.has(session.id),
    parent_id: session.parentId ?? null,
    project_label: folder ? (project?.name ?? mobileFolderLabel(folder)) : null,
    project_path: folder || null,
  };
}

function mobileThreadSummaries(
  sessions: ChatSessionSummary[],
  projects: Project[],
  generatingSessionIds: string[],
): MobileThreadSummary[] {
  const running = new Set(generatingSessionIds);
  const projectByFolder = mobileProjectByFolder(projects);
  const archivedProjectFolders = new Set(
    projects
      .filter((project) => project.archivedAt)
      .map((project) => project.folder),
  );
  return sessions
    .filter((session) => {
      if (session.archivedAt) return false;
      const folder = session.settings?.folder?.trim() ?? "";
      return !folder || !archivedProjectFolders.has(folder);
    })
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session) => mobileThreadSummary(session, running, projectByFolder));
}

function mobileThreadGroups(
  sessions: ChatSessionSummary[],
  projects: Project[],
  sidebar: SessionSidebarState,
  generatingSessionIds: string[],
): MobileThreadGroup[] {
  const running = new Set(generatingSessionIds);
  const projectByFolder = mobileProjectByFolder(projects);
  return groupSessionsByProjects(sessions, projects, sidebar, "")
    .map((group) => ({
      id: group.id,
      label: group.label,
      subtitle: group.subtitle ?? null,
      project_id: group.projectId ?? null,
      threads: group.sessions.map((session) =>
        mobileThreadSummary(session, running, projectByFolder),
      ),
    }))
    .filter((group) => group.threads.length > 0);
}

function mobileModelSummaries(models: ModelInfo[]) {
  return models
    .filter(isUsableMobileModel)
    .slice(0, 120)
    .map((model) => ({ id: model.id, provider: model.owned_by || null }));
}

function isUsableMobileModel(model: ModelInfo): boolean {
  return (
    Boolean(model.id.trim()) &&
    !model.capabilities?.imageOutput &&
    !model.capabilities?.videoOutput
  );
}

const PREVIEW_PANEL_MAX_WIDTH = 900;
const CHAT_MAIN_MIN_WIDTH = 360;
const PREVIEW_PANEL_KEYBOARD_STEP = 32;
const PREVIEW_PANEL_ANIMATION_MS = 190;
const MEDIA_CONTEXT_MESSAGE_LIMIT = 10;
const MEDIA_CONTEXT_CHAR_LIMIT = 1800;
const APP_SESSION_ID = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return (
      "app-" + Math.random().toString(36).slice(2) + Date.now().toString(36)
    );
  }
})();

function attachmentId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return (
      "att-" + Math.random().toString(36).slice(2) + Date.now().toString(36)
    );
  }
}

async function browserFileAttachment(file: File): Promise<ChatAttachment> {
  const mime = file.type || inferAttachmentMime(file.name);
  const textLike =
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript";
  const [content, dataUrl] = await Promise.all([
    textLike
      ? file.slice(0, MAX_ATTACHMENT_BYTES).text()
      : Promise.resolve(undefined),
    readBrowserAttachmentDataUrl(file),
  ]);
  return {
    id: attachmentId(),
    name: file.name || "attachment",
    mime,
    size: file.size,
    content,
    dataUrl,
    truncated: textLike
      ? file.size > MAX_ATTACHMENT_BYTES
      : file.type.startsWith("image/")
        ? file.size > MAX_ATTACHMENT_IMAGE_PREVIEW_BYTES
        : false,
  };
}

function readBrowserAttachmentDataUrl(file: File): Promise<string | undefined> {
  if (
    !file.type.startsWith("image/") ||
    file.size > MAX_ATTACHMENT_IMAGE_PREVIEW_BYTES
  ) {
    return Promise.resolve(undefined);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(typeof reader.result === "string" ? reader.result : undefined);
    reader.onerror = () => resolve(undefined);
    reader.readAsDataURL(file);
  });
}

function renderMessageAttachments(attachments?: ChatAttachment[]) {
  if (!attachments?.length) return null;
  return (
    <div className="message-attachments">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="message-attachment"
          data-testid={`message-attachment-${attachment.id}`}
        >
          {attachment.dataUrl && (
            <img
              className="message-attachment-thumb"
              src={attachment.dataUrl}
              alt=""
            />
          )}
          <span className="message-attachment-name">{attachment.name}</span>
          <span className="message-attachment-meta">
            {attachment.mime}
            {attachment.truncated ? " clipped" : ""}
          </span>
        </div>
      ))}
    </div>
  );
}

function renderMessageMedia(results?: MediaGenerationResult[]) {
  if (!results?.length) return null;
  return (
    <div className="message-media-results" data-testid="message-media-results">
      {results.map((result) => {
        const url = bestMediaResultUrl(result);
        const media = result.media[0];
        const key = `${result.provider_id}-${result.id || result.model}-${result.status}`;
        const preview =
          media?.kind === "video" && media.url ? (
            <video src={media.url} controls />
          ) : media?.url ? (
            <img src={media.url} alt="" />
          ) : (
            <Image size={24} />
          );
        return url ? (
          <a
            className="message-media-preview"
            data-testid="message-media-result"
            href={url}
            target="_blank"
            rel="noreferrer"
            key={key}
            title="Open generated media"
            onClick={(event) => openResponseUrl(event, url)}
          >
            {preview}
          </a>
        ) : (
          <div
            className="message-media-preview placeholder"
            data-testid="message-media-result"
            key={key}
          >
            {preview}
          </div>
        );
      })}
    </div>
  );
}

function openResponseUrl(
  event: MouseEvent<HTMLAnchorElement>,
  url: string,
): void {
  if (!/^https?:\/\//i.test(url)) return;
  event.preventDefault();
  void openExternalUrl(url).catch((error) =>
    console.warn("failed to open URL", error),
  );
}

function previewArtifactsForMessage(
  message: ChatMessage,
): ChatArtifact[] | undefined {
  if (isCompactionCheckpoint(message)) return undefined;
  if (message.role !== "assistant") return undefined;
  const completed = message.artifacts ?? [];
  if (completed.length) return completed;
  if (!message.content) return undefined;
  const live = extractLivePreviewArtifactFromContent(message.content);
  return live ? [live] : undefined;
}

function preferredPreviewArtifact(
  artifacts?: readonly ChatArtifact[],
): ChatArtifact | null {
  const previewable = artifacts?.filter(isPreviewableArtifact) ?? [];
  if (!previewable.length) return null;
  return previewable
    .slice()
    .sort((a, b) => previewArtifactRank(a) - previewArtifactRank(b))[0];
}

function previewArtifactRank(artifact: ChatArtifact): number {
  const name =
    (artifact.filename ?? artifact.title).split(/[\\/]/).pop()?.toLowerCase() ??
    "";
  const source = (artifact.language || extensionOf(name)).toLowerCase();
  if (name === "index.html" || name === "index.htm") return 0;
  if (source === "html" || source === "htm") return 1;
  if (
    source === "js" ||
    source === "jsx" ||
    source === "mjs" ||
    source === "ts" ||
    source === "tsx"
  )
    return 2;
  if (source === "md" || source === "markdown") return 3;
  return 4;
}

function previewAutoOpenKey(
  messageIndex: number,
  message: ChatMessage,
  artifact: ChatArtifact,
): string {
  return `${messageIndex}\0${message.run?.startedAt ?? ""}\0${artifactPreviewAutoOpenKey(artifact)}`;
}

function localhostPreviewArtifact(url: string): ChatArtifact {
  return {
    id: `localhost-preview-${url.replace(/[^a-z0-9]+/gi, "-")}`,
    kind: "text",
    title: url,
    mime: "text/uri-list",
    content: url,
    size: url.length,
    language: "url",
    disposition: "preview",
  };
}

function blankBrowserArtifact(): ChatArtifact {
  return {
    id: "artifact-browser",
    kind: "text",
    title: "Browser",
    mime: "text/uri-list",
    content: "",
    size: 0,
    language: "url",
    disposition: "preview",
  };
}

function blankBrowserPreviewSelection(): PreviewSelection {
  const artifact = blankBrowserArtifact();
  return { artifact, artifacts: [artifact], previewDeferred: false };
}

function sidePanelModeForArtifact(
  artifact: ChatArtifact,
): SessionSidePanelMode {
  return artifact.mime === "text/uri-list" ? "browser" : "artifact";
}

function isPreviewAppActive(status: PreviewAppStatus | null): boolean {
  return (
    Boolean(status?.pid) ||
    status?.status === "installing" ||
    status?.status === "starting" ||
    status?.status === "running"
  );
}

function previewRuntimeText(value?: string | null): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function previewRuntimeFromStatus(
  status: PreviewAppStatus,
  previous?: SessionPreviewRuntime,
): SessionPreviewRuntime {
  const state = previewRuntimeText(status.status) ?? "idle";
  const url =
    previewRuntimeText(status.url) ??
    (state === "installing" || state === "starting"
      ? previous?.url
      : undefined);
  return {
    status: state,
    cwd: previewRuntimeText(status.cwd),
    url,
    pid:
      typeof status.pid === "number" && Number.isFinite(status.pid)
        ? status.pid
        : undefined,
    command: previewRuntimeText(status.command),
    message: previewRuntimeText(status.message),
  };
}

function previewStatusFromRuntime(
  threadId: string,
  runtime?: SessionPreviewRuntime,
): PreviewAppStatus | null {
  if (!runtime) return null;
  return {
    thread_id: threadId,
    status: runtime.status,
    cwd: runtime.cwd ?? "",
    url: runtime.url ?? null,
    pid: runtime.pid ?? null,
    command: runtime.command ?? null,
    message: runtime.message ?? null,
    logs: [],
  };
}

function previewStatusMatchesFolder(
  status: PreviewAppStatus | null,
  folder: string,
): boolean {
  const cwd = previewRuntimeText(folder);
  return !cwd || previewRuntimeFoldersEqual(status?.cwd, cwd);
}

function folderPreviewIdleStatus(
  threadId: string,
  folder: string,
): PreviewAppStatus | null {
  const cwd = previewRuntimeText(folder);
  if (!cwd) return null;
  return {
    thread_id: threadId,
    status: "idle",
    cwd,
    url: null,
    pid: null,
    command: null,
    message: null,
    logs: [],
  };
}

function previewRuntimeStartOptions(folder: string): PreviewAppStartOptions {
  const cwd = previewRuntimeText(folder);
  return cwd ? { cwd } : {};
}

function mergePreviewAppFiles(
  base: readonly PreviewAppFile[],
  updates: readonly PreviewAppFile[],
): PreviewAppFile[] {
  const files = new Map<string, PreviewAppFile>();
  for (const file of [...base, ...updates]) {
    const path = normalizeVirtualFilePath(file.path);
    if (path) files.set(path, { path, content: file.content });
  }
  return [...files.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}

function virtualArtifactPreview(
  path: string,
  content: string,
  existing?: SessionVirtualFile,
): ArtifactWritePreview {
  const oldContent = existing?.content ?? null;
  const changed = oldContent !== content;
  return {
    path,
    exists: Boolean(existing),
    changed,
    old_content: oldContent,
    new_content: content,
    old_bytes: existing?.bytes ?? null,
    new_bytes: textBytes(content),
    diff: changed ? simpleDiff(oldContent, content) : "",
    truncated: false,
  };
}

function simpleDiff(oldContent: string | null, newContent: string): string {
  const oldLines =
    oldContent == null
      ? []
      : oldContent.split(/\r?\n/).map((line) => `-${line}`);
  const newLines = newContent.split(/\r?\n/).map((line) => `+${line}`);
  return [...oldLines, ...newLines].join("\n");
}

function textBytes(content: string): number {
  return new TextEncoder().encode(content).byteLength;
}

function virtualChatArtifact(file: SessionVirtualFile): ChatArtifact {
  const language = extensionOf(file.path);
  return {
    id: `virtual-${file.path}-${file.version}`,
    kind: language === "json" ? "json" : language === "csv" ? "csv" : "code",
    title: file.path,
    filename: file.path,
    mime: mimeForVirtualFile(file.path),
    content: file.content,
    size: file.bytes,
    language,
    disposition: "file",
  };
}

function mimeForVirtualFile(path: string): string {
  const ext = extensionOf(path);
  if (ext === "json") return "application/json";
  if (ext === "csv") return "text/csv";
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "html" || ext === "htm") return "text/html";
  if (ext === "css") return "text/css";
  if (["js", "mjs", "jsx", "ts", "tsx"].includes(ext)) return "text/javascript";
  return "text/plain";
}

function previewSelectionFromRuntime(
  runtime?: SessionPreviewRuntime,
): PreviewSelection | null {
  const url = previewRuntimeBrowserUrl(runtime);
  if (!url) return null;
  const artifact = localhostPreviewArtifact(url);
  return { artifact, artifacts: [artifact], previewDeferred: false };
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

function maxPreviewPanelWidth(): number {
  if (typeof window === "undefined") return PREVIEW_PANEL_MAX_WIDTH;
  return Math.min(
    PREVIEW_PANEL_MAX_WIDTH,
    Math.max(PREVIEW_PANEL_MIN_WIDTH, window.innerWidth - CHAT_MAIN_MIN_WIDTH),
  );
}

function clampPreviewPanelWidth(width: number): number {
  return Math.round(
    Math.min(Math.max(width, PREVIEW_PANEL_MIN_WIDTH), maxPreviewPanelWidth()),
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function MessageEditor({
  initial,
  onSave,
  onCancel,
  saveLabel = "Send",
}: {
  initial: string;
  onSave: (t: string) => void;
  onCancel: () => void;
  saveLabel?: string;
}) {
  const [v, setV] = useState(initial);
  return (
    <div className="msg-editor">
      <textarea
        className="msg-edit-input"
        value={v}
        autoFocus
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (shortcutMatchesEvent("Mod+Enter", e)) onSave(v);
        }}
      />
      <div className="msg-edit-actions">
        <button className="btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn-accent" onClick={() => onSave(v)}>
          {saveLabel}
        </button>
      </div>
    </div>
  );
}

function MemoryBreadcrumbs({ memories }: { memories?: MemoryNotice[] }) {
  if (!memories?.length) return null;
  return (
    <div
      className="memory-breadcrumbs"
      data-testid="memory-breadcrumbs"
      aria-label="Registered memories"
    >
      {memories.map((memory) => (
        <span
          className="memory-crumb"
          key={memory.id}
          title={`${memory.scope_label}: ${memory.summary}`}
        >
          Remembered in {memory.scope_kind}: {memory.summary}
        </span>
      ))}
    </div>
  );
}

type AutomationCard = {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  operation: "created" | "updated";
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function scheduleFromToolResult(step: RunStep): AutomationCard | null {
  if (step.name !== "schedule_create" && step.name !== "schedule_update")
    return null;
  const root = asRecord(step.result);
  const schedule = asRecord(root?.schedule);
  if (!schedule) return null;
  const id = schedule?.id;
  const name = schedule?.name;
  const cron = schedule?.cron;
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    typeof cron !== "string"
  )
    return null;
  return {
    id,
    name,
    cron,
    enabled: schedule.enabled !== false,
    operation: step.name === "schedule_create" ? "created" : "updated",
  };
}

function automationCardsFromRun(run?: RunTrace): AutomationCard[] {
  const cards: AutomationCard[] = [];
  const seen = new Set<string>();
  for (const step of run?.steps ?? []) {
    const card = scheduleFromToolResult(step);
    if (!card || seen.has(card.id)) continue;
    seen.add(card.id);
    cards.push(card);
  }
  return cards;
}

function plural(value: number, unit: string): string {
  return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

function describeScheduleCron(cron: string): string {
  const parts = cron.trim().replace(/\s+/g, " ").split(" ");
  if (parts.length !== 6) return cron;
  const [sec, min, hour, day, month, dow] = parts;
  const minuteInterval = min.match(/^\*\/(\d+)$/);
  const secondInterval = sec.match(/^\*\/(\d+)$/);
  const daily = day === "*" && month === "*";
  if (daily && dow === "*" && hour === "*" && sec === "0" && minuteInterval) {
    return `Every ${plural(Number(minuteInterval[1]), "minute")}`;
  }
  if (daily && dow === "*" && hour === "*" && min === "0" && sec === "0") {
    return "Hourly";
  }
  if (daily && dow === "*" && hour === "*" && min === "*" && secondInterval) {
    return `Every ${plural(Number(secondInterval[1]), "second")}`;
  }
  if (daily && sec === "0" && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    const time = `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
    return dow === "*" ? `Daily at ${time}` : `Runs at ${time}`;
  }
  return cron;
}

function AutomationCards({
  run,
  onOpenSchedules,
}: {
  run?: RunTrace;
  onOpenSchedules: () => void;
}) {
  const cards = automationCardsFromRun(run);
  if (cards.length === 0) return null;
  return (
    <div
      className="automation-cards"
      data-testid="automation-cards"
      aria-label="Automations"
    >
      {cards.map((card) => (
        <div
          className="automation-card"
          key={card.id}
          data-testid="automation-card"
        >
          <div className="automation-card-icon" aria-hidden="true">
            <Calendar size={16} />
          </div>
          <div className="automation-card-copy">
            <div className="automation-card-title">
              <span>{card.name}</span>
              <span
                className={
                  "automation-card-status " +
                  (card.enabled ? "active" : "paused")
                }
              >
                {card.enabled ? "Active" : "Paused"}
              </span>
            </div>
            <div className="automation-card-meta">
              Automation {card.operation} - {describeScheduleCron(card.cron)}
            </div>
          </div>
          <button
            className="automation-card-open"
            type="button"
            onClick={onOpenSchedules}
          >
            Open
          </button>
        </div>
      ))}
    </div>
  );
}

function MilimUsageRidgeline({ usage }: { usage: MilimUsageSummary }) {
  const months = visibleUsageMonths(usage);
  const width = 440;
  const amplitude = usage.hasUsage ? 34 : 0;
  const lineSpacing = 16;
  const lineWidth = 1.2;
  const topPad = amplitude + 8;
  const height = topPad + lineSpacing * (months.length - 1) + 10;
  const maxValue = Math.max(1, ...months.flatMap((month) => month.days));

  return (
    <section
      className="usage-empty-panel"
      data-testid="empty-usage-ridgeline"
      aria-label="Milim usage"
    >
      <svg
        className="usage-ridgeline"
        role="img"
        aria-label="Monthly ridgeline chart of local thread activity"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
      >
        {months.map((month, index) => {
          const base = topPad + index * lineSpacing;
          const line = ridgePath(month.days, base, amplitude, width, maxValue);
          const empty = month.days.every((value) => value === 0);
          const opacity = empty
            ? 0.16
            : 0.38 +
              (months.length <= 1
                ? 0.22
                : (index / (months.length - 1)) * 0.22);
          return (
            <g key={month.key} className="usage-ridge-row">
              <path
                className="usage-ridge-fill"
                d={`${line} L${width},${base} L0,${base} Z`}
              />
              <path
                className="usage-ridge-line"
                d={line}
                style={{ opacity }}
                strokeWidth={lineWidth}
                data-empty={empty || undefined}
              />
            </g>
          );
        })}
      </svg>
      <div className="usage-empty-footer">
        <div className="usage-empty-metrics">
          {usage.metrics.map((metric) => (
            <div className="usage-empty-metric" key={metric.label}>
              <span className="usage-empty-metric-value">{metric.value}</span>
              <span className="usage-empty-metric-label">{metric.label}</span>
            </div>
          ))}
        </div>
        <div className="usage-empty-latest">
          {usage.months[usage.months.length - 1]?.label}
        </div>
      </div>
    </section>
  );
}

function visibleUsageMonths(
  usage: MilimUsageSummary,
): MilimUsageSummary["months"] {
  const indexed = usage.months.map((month, index) => ({ month, index }));
  const active = indexed.filter(({ month }) =>
    month.days.some((value) => value > 0),
  );
  if (active.length === 0) return usage.months.slice(-3);

  const empty = indexed.filter(({ month }) =>
    month.days.every((value) => value === 0),
  );
  const selected = new Set([
    ...active.map(({ index }) => index),
    ...empty.slice(-Math.max(0, 3 - active.length)).map(({ index }) => index),
  ]);
  return indexed
    .filter(({ index }) => selected.has(index))
    .map(({ month }) => month);
}

function ridgePath(
  values: number[],
  base: number,
  amplitude: number,
  width: number,
  maxValue: number,
): string {
  const points = values.map((value, index) => {
    const x = values.length <= 1 ? 0 : (index / (values.length - 1)) * width;
    const y = base - (value / maxValue) * amplitude;
    return [x, y];
  });
  let line = `M${points[0][0]},${points[0][1]}`;
  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1];
    const [x1, y1] = points[index];
    const midX = (x0 + x1) / 2;
    line += ` C${midX},${y0} ${midX},${y1} ${x1},${y1}`;
  }
  return line;
}

function queuedAttachmentLabel(count: number): string {
  return count === 1 ? "1 attachment" : `${count} attachments`;
}

function QueuedMessageTray({
  items,
  busy,
  onRun,
  onEdit,
  onRemove,
}: {
  items: QueuedMessage[];
  busy: boolean;
  onRun: () => void;
  onEdit: (item: QueuedMessage) => void;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="queued-tray" data-testid="queued-message-tray">
      <div className="queued-tray-head">
        <span>
          {items.length === 1
            ? "1 queued message"
            : `${items.length} queued messages`}
        </span>
        {!busy && (
          <button
            className="queued-run"
            type="button"
            onClick={onRun}
            data-testid="queued-run"
          >
            <ArrowRight size={13} />
            <span>{items.length === 1 ? "Run next" : "Run queue"}</span>
          </button>
        )}
      </div>
      <div className="queued-list">
        {items.map((item, index) => {
          const text = item.content.trim();
          const attachmentCount = item.attachments?.length ?? 0;
          return (
            <div
              className="queued-item"
              data-testid="queued-message"
              key={item.id}
            >
              <span className="queued-index">{index + 1}</span>
              <span
                className="queued-copy"
                title={text || queuedAttachmentLabel(attachmentCount)}
              >
                {text || "Attached files"}
              </span>
              {attachmentCount > 0 && (
                <span className="queued-meta">
                  {queuedAttachmentLabel(attachmentCount)}
                </span>
              )}
              <button
                className="queued-action"
                type="button"
                title="Edit queued message"
                aria-label="Edit queued message"
                onClick={() => onEdit(item)}
              >
                <Pencil size={12} />
              </button>
              <button
                className="queued-action"
                type="button"
                title="Remove queued message"
                aria-label="Remove queued message"
                onClick={() => onRemove(item.id)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type ChatNotice = {
  message: string;
  tone: "info" | "warning" | "error";
};

type RunTurnResult = {
  status: "done" | "aborted" | "error" | "skipped";
  messages: ChatMessage[];
  error?: string;
};

type RunTurnOptions = {
  goal?: GoalSettings;
  toolApprovalGrant?: boolean;
};

type ToolApprovalScope = ChatApprovalRequest["scope"];

function toolApprovalMessage(
  scope: ToolApprovalScope,
  model: string,
): ChatMessage {
  return {
    role: "assistant",
    content: "",
    approval: {
      kind: "tool",
      scope,
      status: "pending",
      requestedAt: Date.now(),
      model: model.trim() || undefined,
    },
  };
}

function resolveApprovalMessage(
  message: ChatMessage,
  status: "approved" | "denied",
): ChatMessage {
  if (!message.approval) return message;
  return {
    ...message,
    approval: {
      ...message.approval,
      status,
      resolvedAt: Date.now(),
    },
  };
}

function toolApprovalCardTitle(approval: ChatApprovalRequest): string {
  if (approval.scope === "goal") return "Goal tool access";
  return "Tool access request";
}

function toolApprovalCardDetail(approval: ChatApprovalRequest): string {
  const model = approval.model ? ` for ${approval.model}` : "";
  if (approval.status === "approved") return `Approved${model}.`;
  if (approval.status === "denied") return `Denied${model}.`;
  return approval.scope === "goal"
    ? `Allow this goal run to use tools${model}.`
    : `Allow this reply to use tools${model}.`;
}

function ToolApprovalCard({
  approval,
  disabled,
  onApprove,
  onDeny,
}: {
  approval: ChatApprovalRequest;
  disabled: boolean;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div
      className={`approval-card ${approval.status}`}
      data-testid="tool-approval-card"
    >
      <div className="approval-copy">
        <div className="approval-title">{toolApprovalCardTitle(approval)}</div>
        <div className="approval-detail">
          {toolApprovalCardDetail(approval)}
        </div>
      </div>
      {approval.status === "pending" && (
        <div className="approval-actions">
          <button
            className="approval-btn approve"
            data-testid="approve-tools"
            type="button"
            title="Approve tool access"
            onClick={onApprove}
            disabled={disabled}
          >
            <Check size={13} />
            <span>Approve</span>
          </button>
          <button
            className="approval-btn deny"
            data-testid="deny-tools"
            type="button"
            title="Deny tool access"
            onClick={onDeny}
            disabled={disabled}
          >
            <X size={13} />
            <span>Deny</span>
          </button>
        </div>
      )}
    </div>
  );
}

type GoalLoopState = {
  sessionId: string;
  stopped: boolean;
  decisionController?: AbortController;
};

type PreviewSelection = {
  artifact: ChatArtifact;
  artifacts: ChatArtifact[];
  revision?: ArtifactRevision;
  revisionGroup?: ArtifactRevisionGroup;
  previewDeferred?: boolean;
  autoOpenKey?: string;
};

type ActiveMediaTarget = {
  provider: ProviderInfo;
  model: string;
  kind: MediaKind;
  supportedKinds: MediaKind[];
};

type MediaProviderCatalog = Record<
  string,
  Partial<Record<MediaKind, string[]>>
>;

type ChatSessionSummary = {
  id: string;
  title: string;
  messages: ChatMessage[];
  settings?: {
    folder?: string;
    model?: string;
    sandbox?: boolean;
    computerUse?: boolean;
    privacy?: string;
  };
  model?: string | null;
  parentId?: string;
  updatedAt: number;
  archivedAt?: number;
};

function usageDateKey(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
    : "";
}

function sameChatSessionSummary(
  session: Session,
  summary: ChatSessionSummary,
): boolean {
  return (
    session.id === summary.id &&
    session.title === summary.title &&
    Boolean(session.messages.length) === Boolean(summary.messages.length) &&
    session.settings?.folder === summary.settings?.folder &&
    session.settings?.model === summary.settings?.model &&
    session.settings?.sandbox === summary.settings?.sandbox &&
    session.settings?.computerUse === summary.settings?.computerUse &&
    session.settings?.privacy === summary.settings?.privacy &&
    (session.worker?.model || session.settings?.model || null) ===
      summary.model &&
    session.parentId === summary.parentId &&
    usageDateKey(session.updatedAt) === usageDateKey(summary.updatedAt) &&
    session.archivedAt === summary.archivedAt
  );
}

function createChatSessionSummariesSelector() {
  let previous: ChatSessionSummary[] = [];
  return (
    state: ReturnType<typeof useSessions.getState>,
  ): ChatSessionSummary[] => {
    let changed = previous.length !== state.sessions.length;
    const next = state.sessions.map((session, index) => {
      const cached = previous[index];
      if (cached && sameChatSessionSummary(session, cached)) return cached;
      changed = true;
      return {
        id: session.id,
        title: session.title,
        messages: session.messages.length ? NON_EMPTY_USAGE_MESSAGES : EMPTY,
        settings: session.settings
          ? {
              folder: session.settings.folder,
              model: session.settings.model,
              sandbox: session.settings.sandbox,
              computerUse: session.settings.computerUse,
              privacy: session.settings.privacy,
            }
          : undefined,
        model: session.worker?.model || session.settings?.model || null,
        parentId: session.parentId,
        updatedAt: session.updatedAt,
        archivedAt: session.archivedAt,
      };
    });
    if (!changed) return previous;
    previous = next;
    return next;
  };
}

function addMediaCandidate(
  candidates: Map<string, Set<MediaKind>>,
  model: string | undefined,
  fallbackKind: MediaKind,
  force = false,
): void {
  const trimmed = model?.trim();
  if (!trimmed) return;
  const kind = mediaKindForModelId(trimmed);
  if (!kind && !force) return;
  const kinds = candidates.get(trimmed) ?? new Set<MediaKind>();
  kinds.add(kind ?? fallbackKind);
  candidates.set(trimmed, kinds);
}

function mediaCandidatesForProvider(
  provider: ProviderInfo,
  settings: MediaSettings,
  catalog: MediaProviderCatalog,
): Map<string, Set<MediaKind>> {
  const candidates = new Map<string, Set<MediaKind>>();
  addMediaCandidate(candidates, defaultMediaModel(provider), "image", true);
  addMediaCandidate(
    candidates,
    settings.modelByProvider[provider.id],
    "image",
    true,
  );
  for (const id of settings.favoriteModelIdsByProvider[provider.id] ?? []) {
    addMediaCandidate(candidates, id, "image", true);
  }
  for (const id of provider.models ?? []) {
    addMediaCandidate(candidates, id, "image");
  }
  for (const kind of ["image", "video"] as MediaKind[]) {
    for (const id of catalog[provider.id]?.[kind] ?? []) {
      addMediaCandidate(candidates, id, kind, true);
    }
  }
  return candidates;
}

function mediaModelsForPicker(
  providers: ProviderInfo[],
  settings: MediaSettings,
  catalog: MediaProviderCatalog,
): ModelInfo[] {
  return providers.flatMap((provider) =>
    Array.from(
      mediaCandidatesForProvider(provider, settings, catalog),
      ([id, kinds]) => ({
        id,
        owned_by: `${provider.name} media`,
        capabilities: {
          imageOutput: kinds.has("image"),
          videoOutput: kinds.has("video"),
        },
      }),
    ),
  );
}

function mergeModelLists(
  chatModels: ModelInfo[],
  mediaModels: ModelInfo[],
): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const model of chatModels) byId.set(model.id, model);
  for (const model of mediaModels) {
    const existing = byId.get(model.id);
    byId.set(
      model.id,
      existing
        ? {
            ...existing,
            owned_by: existing.owned_by || model.owned_by,
            capabilities: {
              ...existing.capabilities,
              ...model.capabilities,
            },
          }
        : model,
    );
  }
  return Array.from(byId.values());
}

function executePlanPrompt(plan: string): string {
  return [
    "Execute the approved implementation plan below.",
    "Apply the changes in the current workspace. Keep the implementation scoped to the plan unless the code proves a small adjustment is necessary.",
    "",
    "Approved plan:",
    plan,
  ].join("\n");
}

function resolveActiveMediaTarget(
  model: string,
  providers: ProviderInfo[],
  settings: MediaSettings,
  catalog: MediaProviderCatalog,
): ActiveMediaTarget | null {
  const selected = model.trim();
  if (!selected) return null;
  for (const provider of providers) {
    const candidates = mediaCandidatesForProvider(provider, settings, catalog);
    const kinds = candidates.get(selected);
    if (kinds?.size) {
      const supportedKinds = Array.from(kinds);
      return {
        provider,
        model: selected,
        kind: supportedKinds[0],
        supportedKinds,
      };
    }
  }
  return null;
}

function updateMediaMessage(
  sessionId: string,
  requestId: string,
  patch: Partial<ChatMessage>,
): void {
  const store = useSessions.getState();
  const session = store.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const messages = session.messages.map((message) =>
    message.mediaRequestId === requestId ? { ...message, ...patch } : message,
  );
  store.setMessages(sessionId, messages, { autoTitle: false });
}

function replaceMediaResult(
  sessionId: string,
  requestId: string,
  result: MediaGenerationResult,
): void {
  const store = useSessions.getState();
  const session = store.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const messages = session.messages.map((message) => {
    if (message.mediaRequestId !== requestId) return message;
    const current = message.mediaResults ?? [];
    const index = current.findIndex(
      (item) =>
        item.provider_id === result.provider_id && item.id === result.id,
    );
    const mediaResults =
      index >= 0
        ? current.map((item, itemIndex) =>
            itemIndex === index ? { ...item, ...result } : item,
          )
        : [result, ...current];
    return {
      ...message,
      content: bestMediaResultUrl(result) ? "" : mediaResultContent(result),
      mediaResults,
    };
  });
  store.setMessages(sessionId, messages, { autoTitle: false });
}

function codexImageMediaResult(
  ev: Extract<CodexRunEvent, { type: "image" }>,
  model: string,
): MediaGenerationResult {
  return {
    id: ev.id || attachmentId(),
    object: "media.generation",
    provider_id: "codex",
    provider: "Codex",
    provider_kind: "openai_compatible",
    kind: "image",
    model,
    status: ev.status || "completed",
    output: ev.revised_prompt ?? undefined,
    media: [{ url: ev.url, kind: "image", mime: "image/png" }],
    urls: { web: ev.url },
    privacy: { mode: "off", redacted: false, detections: 0, kinds: "" },
    raw: ev,
  };
}

function appendAssistantMediaResult(
  sessionId: string,
  result: MediaGenerationResult,
): void {
  const store = useSessions.getState();
  const session = store.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const messages = session.messages.slice();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const current = message.mediaResults ?? [];
    const mediaResults = current.some(
      (item) =>
        item.provider_id === result.provider_id && item.id === result.id,
    )
      ? current.map((item) =>
          item.provider_id === result.provider_id && item.id === result.id
            ? result
            : item,
        )
      : [...current, result];
    messages[index] = { ...message, mediaResults };
    store.setMessages(sessionId, messages, { autoTitle: false });
    return;
  }
}

function attachAssistantWorkspaceCheckpoint(
  sessionId: string,
  checkpoint: WorkspaceCheckpoint,
): void {
  const store = useSessions.getState();
  const session = store.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const messages = session.messages.slice();
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "assistant") continue;
    messages[index] = { ...messages[index], workspaceCheckpoint: checkpoint };
    store.setMessages(sessionId, messages, { autoTitle: false });
    return;
  }
}

function compactText(value: string, max = 96): string {
  const text = value.trim().replace(/\s+/g, " ");
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "..." : text;
}

function mediaContextLine(message: ChatMessage): string | null {
  const text = message.content.trim();
  if (message.role === "user") {
    return text ? `User: ${compactText(text, 420)}` : null;
  }
  if (message.mediaResults?.length) {
    const summaries = message.mediaResults.slice(0, 2).map((result) => {
      const kind = String(result.media[0]?.kind ?? result.kind ?? "media");
      const status = result.status.trim() || "submitted";
      return bestMediaResultUrl(result)
        ? `generated ${kind} (${status})`
        : `${kind} generation ${status}`;
    });
    return summaries.length ? `Assistant: ${summaries.join(", ")}.` : null;
  }
  if (!text || text.startsWith("Generating ")) return null;
  return `Assistant: ${compactText(text, 420)}`;
}

function boundedMediaContextLines(messages: ChatMessage[]): string[] {
  const lines = messages
    .map(mediaContextLine)
    .filter((line): line is string => Boolean(line))
    .slice(-MEDIA_CONTEXT_MESSAGE_LIMIT);
  const selected: string[] = [];
  let chars = 0;
  for (const line of lines.slice().reverse()) {
    const nextChars = chars + line.length + 1;
    if (selected.length && nextChars > MEDIA_CONTEXT_CHAR_LIMIT) break;
    selected.push(line);
    chars = nextChars;
  }
  return selected.reverse();
}

function mediaPromptWithHistory(
  baseMessages: ChatMessage[],
  currentPrompt: string,
): string {
  const context = boundedMediaContextLines(baseMessages);
  if (!context.length) return currentPrompt;
  return [
    "Use the recent chat context only to resolve references and maintain continuity. Create the latest requested media.",
    "",
    "Recent chat:",
    ...context,
    "",
    `Latest request: ${currentPrompt}`,
  ].join("\n");
}

export function ChatView({
  onManageAgents,
  onOpenSchedules,
  composerDraft,
  gitPanelRequest = 0,
  onComposerDraftConsumed,
  skillsRevision = 0,
}: {
  onManageAgents: () => void;
  onOpenSchedules: () => void;
  composerDraft?: { id: number; text: string } | null;
  gitPanelRequest?: number;
  onComposerDraftConsumed?: (id: number) => void;
  skillsRevision?: number;
}) {
  markPerfRender("ChatView");
  const { openContextMenu } = useContextMenu();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [input, setInputState] = useState("");
  const [providersOpen, setProvidersOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [mediaCatalog, setMediaCatalog] = useState<MediaProviderCatalog>({});
  const [mediaKind, setMediaKind] = useState<MediaKind>("image");
  const [mediaAdvanced, setMediaAdvanced] = useState("{}");
  const [mediaSchema, setMediaSchema] = useState<MediaModelSchema | null>(null);
  const [mediaParameterValues, setMediaParameterValues] = useState<
    Record<string, unknown>
  >({});
  const [mediaSchemaLoading, setMediaSchemaLoading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [speakingIndex, setSpeakingIndex] = useState<number | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<
    ChatAttachment[]
  >([]);
  const [previewSelection, setPreviewSelection] =
    useState<PreviewSelection | null>(null);
  const [previewAppStatus, setPreviewAppStatus] =
    useState<PreviewAppStatus | null>(null);
  const [previewAppBusy, setPreviewAppBusy] = useState<
    "start" | "stop" | "restart" | null
  >(null);
  const [previewPanelClosing, setPreviewPanelClosing] = useState(false);
  const [gitStatus, setGitStatus] = useState<WorkspaceGitStatus | null>(null);
  const [dismissedPreviewKey, setDismissedPreviewKey] = useState<string | null>(
    null,
  );
  const [chatNotice, setChatNotice] = useState<ChatNotice | null>(null);
  const [goalPanelOpen, setGoalPanelOpen] = useState(false);
  const [goalPrefill, setGoalPrefill] = useState<string | null>(null);
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [sessionsHydrated, setSessionsHydrated] = useState(() =>
    useSessions.persist.hasHydrated(),
  );
  const previewArtifact = previewSelection?.artifact ?? null;

  const activeId = useSessions((s) => s.activeId);
  const composerDraftsRef = useRef<Record<string, string>>({});
  const sessionSummariesSelector = useMemo(
    createChatSessionSummariesSelector,
    [],
  );
  const sessionSummaries = useSessions(sessionSummariesSelector);
  const messages = useSessions(
    (s) => s.sessions.find((x) => x.id === s.activeId)?.messages ?? EMPTY,
  );
  const artifactRevisionGroupsForThread = useMemo(
    () => artifactRevisionGroups(messages),
    [messages],
  );
  const artifactRevisionsByOccurrence = useMemo(
    () => artifactRevisionChoiceByOccurrence(artifactRevisionGroupsForThread),
    [artifactRevisionGroupsForThread],
  );
  const sentHistory = useMemo(
    () =>
      messages
        .filter((message) => message.role === "user" && message.content.trim())
        .map((message) => message.content.trim()),
    [messages],
  );
  const activeTitle = useSessions(
    (s) =>
      s.sessions.find((x) => x.id === s.activeId)?.title ?? "Current thread",
  );
  const activeWorker = useSessions(
    (s) => s.sessions.find((x) => x.id === s.activeId)?.worker,
  );
  const projects = useSessions((s) => s.projects);
  const sidebarState = useSessions((s) => s.sidebar);
  const generatingSessionIds = useSessions((s) => s.generatingSessionIds);
  const queuedMessages = useSessions(
    (s) => s.queuedMessagesBySession[s.activeId] ?? EMPTY_QUEUE,
  );
  const sidePanelMode = useSessions(
    (s) => s.sessions.find((x) => x.id === s.activeId)?.sidePanelMode ?? null,
  );
  const sidePanelOpen = useSessions(
    (s) =>
      s.sessions.find((x) => x.id === s.activeId)?.artifactPanelOpen === true,
  );
  const artifactPanelTab = useSessions(
    (s) =>
      s.sessions.find((x) => x.id === s.activeId)?.artifactPanelTab ??
      "preview",
  );
  const activePreviewRuntime = useSessions((s) => {
    const session = s.sessions.find((x) => x.id === s.activeId);
    const activeFolder = session?.settings?.folder ?? "";
    return activeFolder.trim()
      ? s.previewRuntimesByKey[
          previewRuntimeKeyForThread(s.activeId, activeFolder)
        ]
      : session?.previewRuntime;
  });
  const setMessages = useSessions((s) => s.setMessages);
  const markArtifactSaved = useSessions((s) => s.markArtifactSaved);
  const upsertVirtualFiles = useSessions((s) => s.upsertVirtualFiles);
  const commitResponseMetrics = useSessions((s) => s.commitResponseMetrics);
  const setSessionSidePanelOpen = useSessions((s) => s.setSidePanelOpen);
  const setSessionSidePanelMode = useSessions((s) => s.setSidePanelMode);
  const setArtifactPanelTab = useSessions((s) => s.setArtifactPanelTab);
  const setSessionPreviewRuntime = useSessions((s) => s.setPreviewRuntime);
  const setPreviewRuntimeByKey = useSessions((s) => s.setPreviewRuntimeByKey);
  const updateThreadSettings = useSessions((s) => s.updateSettings);
  const switchToSession = useSessions((s) => s.switchTo);
  const enqueueQueuedMessage = useSessions((s) => s.enqueueQueuedMessage);
  const removeQueuedMessage = useSessions((s) => s.removeQueuedMessage);
  const rawThreadSettings = useSessions(
    (s) => s.sessions.find((x) => x.id === s.activeId)?.settings,
  );
  const threadSettings = useMemo(
    () => ({
      ...DEFAULT_THREAD_SETTINGS,
      ...rawThreadSettings,
      goal: normalizeGoalSettings(
        rawThreadSettings?.goal ?? DEFAULT_GOAL_SETTINGS,
      ),
    }),
    [rawThreadSettings],
  );
  const agents = useAgents((s) => s.agents);
  const voice = useSettings((s) => s.voice);
  const mediaSettings = useSettings((s) => s.media);
  const setMediaSettings = useSettings((s) => s.setMediaSettings);
  const previewPanelWidth = useUiPreferences((s) => s.previewPanelWidth);
  const setPreviewPanelWidth = useUiPreferences((s) => s.setPreviewPanelWidth);
  const appShortcuts = useUiPreferences((s) => s.appShortcuts);
  const toggleSidebar = useUiPreferences((s) => s.toggleSidebar);
  const autoTitleChats = useUiPreferences((s) => s.autoTitleChats);
  const interfaceMode = useUiPreferences((s) => s.interfaceMode);
  const experimentalHashlinePatch = useUiPreferences(
    (s) => s.experimentalHashlinePatch,
  );
  const activeTheme = useTheme((s) => s.theme);
  const backgroundFit = useUiPreferences((s) => s.backgroundFit);
  const backgroundTreatment = useUiPreferences((s) => s.backgroundTreatment);
  const showMcp = featureVisibleInMode("mcp", interfaceMode);
  const showMemoryManager = featureVisibleInMode(
    "memoryManager",
    interfaceMode,
  );
  const showMedia = featureVisibleInMode("media", interfaceMode);
  const {
    model,
    instructions,
    folder,
    sandbox,
    computerUse,
    memory,
    activeAgentId,
    privacy,
    toolApproval,
    planMode,
    goal,
  } = threadSettings;
  const activePreviewRuntimeKey = previewRuntimeKeyForThread(activeId, folder);
  const canOpenGitPanel = gitStatus?.state === "ready" && gitStatus.is_repo;
  const gitPanelChecking = Boolean(folder.trim()) && gitStatus === null;
  const canShowGitPanel =
    canOpenGitPanel || (sidePanelMode === "git" && gitPanelChecking);
  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === activeAgentId) ?? null,
    [activeAgentId, agents],
  );
  const workspaceProjects = useMemo(
    () =>
      projects
        .filter((project) => !project.archivedAt)
        .map((project) => ({ name: project.name, folder: project.folder })),
    [projects],
  );
  const milimUsage = useMemo(
    () => summarizeMilimUsage(sessionSummaries, projects),
    [projects, sessionSummaries],
  );
  const effectiveModel = activeWorker?.model || activeAgent?.model || model;
  const enabledMediaProviders = useMemo(
    () => mediaProviders(providers),
    [providers],
  );
  const mediaModelEntries = useMemo(
    () =>
      showMedia
        ? mediaModelsForPicker(
            enabledMediaProviders,
            mediaSettings,
            mediaCatalog,
          )
        : [],
    [enabledMediaProviders, mediaSettings, mediaCatalog, showMedia],
  );

  function persistPreviewRuntimeStatus(status: PreviewAppStatus) {
    const state = useSessions.getState();
    const previous = folder.trim()
      ? state.previewRuntimesByKey[activePreviewRuntimeKey]
      : state.sessions.find((session) => session.id === activeId)
          ?.previewRuntime;
    const runtime = previewRuntimeFromStatus(status, previous);
    if (folder.trim()) setPreviewRuntimeByKey(activePreviewRuntimeKey, runtime);
    else setSessionPreviewRuntime(activeId, runtime);
  }

  function currentVirtualProjectFiles(sessionId = activeId): PreviewAppFile[] {
    return sessionVirtualProjectFiles(
      useSessions
        .getState()
        .sessions.find((session) => session.id === sessionId),
    );
  }

  function currentVirtualFile(
    path: string,
    sessionId = activeId,
  ): SessionVirtualFile | undefined {
    const normalized = normalizeVirtualFilePath(path);
    if (!normalized) return undefined;
    return useSessions
      .getState()
      .sessions.find((session) => session.id === sessionId)?.virtualFiles?.[
      normalized
    ];
  }

  function virtualRuntimeFilesWith(
    updates: readonly PreviewAppFile[],
  ): PreviewAppFile[] {
    return mergePreviewAppFiles(currentVirtualProjectFiles(), updates);
  }

  useEffect(() => {
    const state = useSessions.getState();
    const runtime = folder.trim()
      ? state.previewRuntimesByKey[activePreviewRuntimeKey]
      : state.sessions.find((session) => session.id === activeId)
          ?.previewRuntime;
    const status = previewStatusFromRuntime(activePreviewRuntimeKey, runtime);
    setPreviewAppStatus(
      previewStatusMatchesFolder(status, folder) ? status : null,
    );
  }, [activeId, activePreviewRuntimeKey, folder, sessionsHydrated]);

  useEffect(() => {
    let cancelled = false;
    async function pollPreviewApp() {
      try {
        const status = await getPreviewAppStatus(activePreviewRuntimeKey);
        if (!cancelled) {
          if (previewStatusMatchesFolder(status, folder)) {
            setPreviewAppStatus(status);
            persistPreviewRuntimeStatus(status);
          } else {
            setPreviewAppStatus(null);
            if (folder.trim())
              setPreviewRuntimeByKey(activePreviewRuntimeKey, undefined);
            else setSessionPreviewRuntime(activeId, undefined);
          }
        }
      } catch {
        if (!cancelled) setPreviewAppStatus(null);
      }
    }
    void pollPreviewApp();
    const timer = window.setInterval(() => void pollPreviewApp(), 2500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    activeId,
    activePreviewRuntimeKey,
    folder,
    setPreviewRuntimeByKey,
    setSessionPreviewRuntime,
  ]);
  const pickerModels = useMemo(
    () => mergeModelLists(models, mediaModelEntries),
    [models, mediaModelEntries],
  );
  const activeMediaTarget = useMemo(
    () =>
      showMedia
        ? resolveActiveMediaTarget(
            effectiveModel,
            enabledMediaProviders,
            mediaSettings,
            mediaCatalog,
          )
        : null,
    [
      effectiveModel,
      enabledMediaProviders,
      mediaSettings,
      mediaCatalog,
      showMedia,
    ],
  );
  const activeWorkerRunning =
    activeWorker?.status === "queued" || activeWorker?.status === "running";
  const busy = generatingSessionIds.includes(activeId) || activeWorkerRunning;

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const generationControllersRef = useRef<Map<string, AbortController>>(
    new Map(),
  );
  const childThreadEventControllersRef = useRef<Map<string, AbortController>>(
    new Map(),
  );
  const childThreadLiveIdsRef = useRef<Map<string, Set<string>>>(new Map());
  const childThreadEventsRef = useRef<Map<string, ThreadEvent[]>>(new Map());
  const speechRef = useRef<{ audio: HTMLAudioElement; url: string } | null>(
    null,
  );
  const previewResizeStartRef = useRef<{
    clientX: number;
    width: number;
  } | null>(null);
  const previewCloseTimeoutRef = useRef<number | null>(null);
  const stopShortcutConfirmUntilRef = useRef(0);
  const stopShortcutConfirmTimerRef = useRef<number | null>(null);
  const currentThreadIdRef = useRef(activeId);
  const previousThreadIdRef = useRef<string | null>(null);
  const restoredPreviewThreadRef = useRef<string | null>(null);
  const sidePanelOpenRef = useRef(false);
  const autoPreviewRuntimeStartedRef = useRef(new Set<string>());
  const mobileRelayPollingRef = useRef(false);
  const scheduleRunPollingRef = useRef(false);
  const goalLoopRef = useRef<GoalLoopState | null>(null);
  const queueDrainRef = useRef<Set<string>>(new Set());
  const compactionInFlightRef = useRef(false);
  const [previewResizing, setPreviewResizing] = useState(false);

  function setInput(nextInput: SetStateAction<string>) {
    setInputState((current) => {
      const next =
        typeof nextInput === "function" ? nextInput(current) : nextInput;
      if (next) composerDraftsRef.current[activeId] = next;
      else delete composerDraftsRef.current[activeId];
      return next;
    });
  }

  function clearPreviewCloseTimer() {
    if (previewCloseTimeoutRef.current == null) return;
    window.clearTimeout(previewCloseTimeoutRef.current);
    previewCloseTimeoutRef.current = null;
  }

  useEffect(() => {
    if (sessionsHydrated) return;
    if (useSessions.persist.hasHydrated()) {
      setSessionsHydrated(true);
      return;
    }
    return useSessions.persist.onFinishHydration(() =>
      setSessionsHydrated(true),
    );
  }, [sessionsHydrated]);

  useEffect(() => {
    if (currentThreadIdRef.current === activeId) return;
    previousThreadIdRef.current = currentThreadIdRef.current;
    currentThreadIdRef.current = activeId;
    const nextDraft = composerDraftsRef.current[activeId] ?? "";
    setInputState(nextDraft);
    if (!nextDraft && messages.length === 0) focusComposer();
  }, [activeId, messages.length]);

  function scrollToChatBottom() {
    const el = chatScrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }

  function isLiveChildThread(thread: ChildThreadInfo): boolean {
    return thread.status === "queued" || thread.status === "running";
  }

  function rememberedChildEvents(event: ThreadEvent): ThreadEvent[] {
    const existing = childThreadEventsRef.current.get(event.thread_id) ?? [];
    if (existing.some((item) => item.id === event.id)) return existing;
    const next = [...existing, event];
    childThreadEventsRef.current.set(event.thread_id, next);
    return next;
  }

  function stopChildThreadEventsIfIdle(parentId: string) {
    const live = childThreadLiveIdsRef.current.get(parentId);
    if (live?.size) return;
    childThreadLiveIdsRef.current.delete(parentId);
    const controller = childThreadEventControllersRef.current.get(parentId);
    if (!controller) return;
    controller.abort();
    childThreadEventControllersRef.current.delete(parentId);
  }

  function applyPushedChildThreadEvent(parentId: string, ev: AgentEvent) {
    const thread = ev.thread;
    if (!thread || thread.parent_id !== parentId) return;
    const live =
      childThreadLiveIdsRef.current.get(parentId) ?? new Set<string>();
    childThreadLiveIdsRef.current.set(parentId, live);
    if (isLiveChildThread(thread)) live.add(thread.id);
    else live.delete(thread.id);

    const store = useSessions.getState();
    const events = ev.event
      ? rememberedChildEvents(ev.event)
      : childThreadEventsRef.current.get(thread.id);
    if (ev.type === "child_thread_started") {
      store.upsertChildThread(parentId, thread, events);
    } else if (
      ev.type === "child_thread_event" ||
      ev.type === "child_thread_done" ||
      ev.type === "child_thread_error"
    ) {
      store.updateChildThread(thread, events);
    }
    if (!isLiveChildThread(thread))
      childThreadEventsRef.current.delete(thread.id);
    if (
      !isLiveChildThread(thread) &&
      !generationControllersRef.current.has(parentId)
    ) {
      stopChildThreadEventsIfIdle(parentId);
    }
  }

  function startChildThreadEvents(parentId: string) {
    if (childThreadEventControllersRef.current.has(parentId)) return;
    const controller = new AbortController();
    childThreadEventControllersRef.current.set(parentId, controller);
    childThreadLiveIdsRef.current.set(
      parentId,
      childThreadLiveIdsRef.current.get(parentId) ?? new Set(),
    );
    void streamChildThreadEvents(
      parentId,
      (ev) => applyPushedChildThreadEvent(parentId, ev),
      controller.signal,
    )
      .catch((error) => {
        if (!controller.signal.aborted)
          console.warn("child thread event stream failed", error);
      })
      .finally(() => {
        if (
          childThreadEventControllersRef.current.get(parentId) === controller
        ) {
          childThreadEventControllersRef.current.delete(parentId);
        }
      });
  }

  useEffect(() => {
    const running = new Set(generatingSessionIds);
    generationControllersRef.current.forEach((controller, id) => {
      if (running.has(id)) return;
      controller.abort();
      generationControllersRef.current.delete(id);
      stopChildThreadEventsIfIdle(id);
    });
  }, [generatingSessionIds]);

  function updateAutoScrollCoupling() {
    const el = chatScrollRef.current;
    if (!el) return;
    stickToBottomRef.current = isNearScrollBottom(el);
  }

  useEffect(() => {
    listModelsDetailed().then((m) => {
      setModels(m);
      setModelsLoaded(true);
    });
  }, []);

  useEffect(() => {
    listProviders().then(setProviders);
  }, []);

  useEffect(() => {
    listSkills().then(setSkills);
  }, [skillsRevision]);

  useEffect(() => {
    if (!showMedia || enabledMediaProviders.length === 0) {
      setMediaCatalog({});
      return;
    }
    let cancelled = false;
    async function loadMediaCatalogs() {
      const rows = await Promise.all(
        enabledMediaProviders.flatMap((provider) =>
          (["image", "video"] as MediaKind[]).map(async (kind) => {
            try {
              const models = await listMediaModels(provider.id, kind);
              return {
                providerId: provider.id,
                kind,
                ids: models.map((item) => item.id).filter(Boolean),
              };
            } catch {
              return { providerId: provider.id, kind, ids: [] };
            }
          }),
        ),
      );
      if (cancelled) return;
      const next: MediaProviderCatalog = {};
      for (const row of rows) {
        next[row.providerId] ??= {};
        next[row.providerId][row.kind] = row.ids;
      }
      setMediaCatalog(next);
    }
    void loadMediaCatalogs();
    return () => {
      cancelled = true;
    };
  }, [
    enabledMediaProviders.map((provider) => provider.id).join("\u0000"),
    showMedia,
  ]);

  useEffect(() => {
    if (modelsLoaded && !model && models[0]?.id) {
      updateThreadSettings(activeId, { model: models[0].id });
    }
  }, [activeId, model, models, modelsLoaded, updateThreadSettings]);

  useEffect(() => {
    if (!activeMediaTarget) {
      setMediaSchema(null);
      setMediaParameterValues({});
      setMediaSchemaLoading(false);
      setMediaError(null);
      return;
    }
    const key = mediaPreferenceKey(
      activeMediaTarget.provider.id,
      activeMediaTarget.model,
    );
    const saved = useSettings.getState().media;
    setMediaKind(activeMediaTarget.kind);
    setMediaAdvanced(
      saved.advancedByProviderModel[key] ??
        defaultMediaAdvanced(activeMediaTarget.provider),
    );
    setMediaParameterValues(saved.parametersByProviderModel[key] ?? {});
    setMediaSettings({
      providerId: activeMediaTarget.provider.id,
      modelByProvider: {
        ...saved.modelByProvider,
        [activeMediaTarget.provider.id]: activeMediaTarget.model,
      },
    });

    let cancelled = false;
    setMediaSchemaLoading(true);
    setMediaError(null);
    getMediaModelSchema(activeMediaTarget.provider.id, activeMediaTarget.model)
      .then((schema) => {
        if (cancelled) return;
        setMediaSchema(schema);
        const nextSaved =
          useSettings.getState().media.parametersByProviderModel[key];
        setMediaParameterValues({ ...schemaDefaults(schema), ...nextSaved });
      })
      .catch((e) => {
        if (!cancelled) {
          setMediaSchema(null);
          setMediaError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (!cancelled) setMediaSchemaLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeMediaTarget?.provider.id, activeMediaTarget?.model]);

  useEffect(() => {
    if (stickToBottomRef.current) scrollToChatBottom();
  }, [messages]);

  useEffect(() => {
    stickToBottomRef.current = true;
    scrollToChatBottom();
    setPendingAttachments([]);
    setChatNotice(null);
  }, [activeId]);

  useEffect(() => {
    if (!composerDraft) return;
    setInput(composerDraft.text);
    setChatNotice({
      tone: "info",
      message: "Git action loaded into composer.",
    });
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')
        ?.focus();
    });
    onComposerDraftConsumed?.(composerDraft.id);
  }, [composerDraft, onComposerDraftConsumed]);

  useEffect(() => {
    if (!gitPanelRequest) return;
    openGitPanel();
  }, [gitPanelRequest]);

  useEffect(() => {
    return () => {
      if (previewCloseTimeoutRef.current != null) {
        window.clearTimeout(previewCloseTimeoutRef.current);
        previewCloseTimeoutRef.current = null;
      }
      if (stopShortcutConfirmTimerRef.current != null) {
        window.clearTimeout(stopShortcutConfirmTimerRef.current);
        stopShortcutConfirmTimerRef.current = null;
      }
      stopSpeech(false);
      const store = useSessions.getState();
      generationControllersRef.current.forEach((controller, id) => {
        controller.abort();
        store.setSessionGenerating(id, false);
      });
      generationControllersRef.current.clear();
      childThreadEventControllersRef.current.forEach((controller) =>
        controller.abort(),
      );
      childThreadEventControllersRef.current.clear();
      childThreadLiveIdsRef.current.clear();
    };
  }, []);

  // Keep the server's host working folder in sync with the picked folder, so
  // the read_file/write_file/edit_file/list_dir/shell tools operate within it.
  useEffect(() => {
    let cancelled = false;
    const nextFolder = folder ?? "";
    setGitStatus(null);
    void (async () => {
      const workspaceSet = await setWorkspace(nextFolder);
      if (cancelled || !workspaceSet || !nextFolder.trim()) return;
      const nextStatus = await getWorkspaceGitStatus();
      if (!cancelled) setGitStatus(nextStatus);
    })();
    return () => {
      cancelled = true;
    };
  }, [folder]);

  // Keep the server's computer-use gate in sync with the toggle.
  useEffect(() => {
    void setComputerUse(computerUse);
  }, [computerUse]);

  // Keep the server's process-global outbound privacy gate in sync with this thread's selected mode.
  useEffect(() => {
    void setPrivacyMode(privacy);
  }, [privacy]);

  const cyclePrivacy = () => {
    const next: PrivacyMode =
      privacy === "off" ? "redact" : privacy === "redact" ? "block" : "off";
    updateThreadSettings(activeId, { privacy: next });
  };

  const cycleToolApproval = () => {
    const idx = TOOL_APPROVAL_ORDER.indexOf(toolApproval);
    updateThreadSettings(activeId, {
      toolApproval: TOOL_APPROVAL_ORDER[(idx + 1) % TOOL_APPROVAL_ORDER.length],
    });
  };

  function setPlanModeActive(active: boolean): boolean {
    updateThreadSettings(activeId, { planMode: active });
    setChatNotice(
      active
        ? {
            tone: "info",
            message: "Plan Mode on. Tools are limited to read-only inspection.",
          }
        : null,
    );
    return true;
  }

  const tokens = useMemo(() => {
    const chars =
      messages.reduce((n, m) => n + wireMessageContent(m).length, 0) +
      input.length +
      pendingAttachments.reduce(
        (n, attachment) => n + (attachment.content?.length ?? 0),
        0,
      ) +
      instructions.length;
    return Math.round(chars / 4);
  }, [messages, input, instructions, pendingAttachments]);
  const activeContextBudget = useMemo(
    () => modelContextBudget(effectiveModel.trim(), pickerModels),
    [effectiveModel, pickerModels],
  );

  const ttsReady =
    voice.ttsEnabled &&
    (voice.ttsProvider === "piper"
      ? Boolean(voice.piperCommand.trim() && voice.piperModelPath.trim())
      : Boolean(voice.ttsCommand.trim()));

  function artifactRevisionChoice(messageIndex: number, artifactIndex: number) {
    return artifactRevisionsByOccurrence.get(
      artifactOccurrenceKey(messageIndex, artifactIndex),
    );
  }

  const latestPreviewSelection = useMemo((): PreviewSelection | null => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      const previewDeferred = busy && i === messages.length - 1;
      const localhostUrl = extractLocalhostUrlFromRunTrace(message.run);
      if (localhostUrl) {
        const artifact = localhostPreviewArtifact(localhostUrl);
        return {
          artifact,
          artifacts: [artifact],
          previewDeferred: false,
          autoOpenKey: `${i}\0${message.run?.startedAt ?? ""}\0localhost\0${localhostUrl}`,
        };
      }
      const completed = preferredPreviewArtifact(message.artifacts);
      if (completed) {
        const artifactIndex =
          message.artifacts?.findIndex(
            (artifact) => artifact.id === completed.id,
          ) ?? -1;
        const choice =
          artifactIndex >= 0
            ? artifactRevisionChoice(i, artifactIndex)
            : undefined;
        return {
          artifact: choice?.revision.artifact ?? completed,
          artifacts: choice?.revision.artifacts ??
            message.artifacts ?? [completed],
          revision: choice?.revision,
          revisionGroup: choice?.group,
          previewDeferred,
          autoOpenKey: previewAutoOpenKey(i, message, completed),
        };
      }
      if (i === messages.length - 1 && message.content) {
        const live = extractLivePreviewArtifactFromContent(message.content);
        if (live)
          return {
            artifact: live,
            artifacts: [live],
            previewDeferred,
            autoOpenKey: previewAutoOpenKey(i, message, live),
          };
      }
    }
    return null;
  }, [artifactRevisionsByOccurrence, busy, messages]);

  const latestRuntimePreview = useMemo((): {
    key: string;
    artifacts: ChatArtifact[];
  } | null => {
    if (folder.trim() || busy) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "assistant" || !message.artifacts?.length) continue;
      if (extractLocalhostUrlFromRunTrace(message.run)) return null;
      const files = previewRuntimeFiles(message.artifacts);
      if (!files.length || !hasPreviewPackageJson(files)) continue;
      return {
        key: `${i}\0${message.run?.startedAt ?? ""}\0${message.artifacts.map((artifact) => artifact.id).join("\0")}`,
        artifacts: [...message.artifacts],
      };
    }
    return null;
  }, [busy, folder, messages]);

  const matchingPreviewRuntime = useMemo(() => {
    const status = previewStatusFromRuntime(
      activePreviewRuntimeKey,
      activePreviewRuntime,
    );
    return previewStatusMatchesFolder(status, folder)
      ? activePreviewRuntime
      : undefined;
  }, [activePreviewRuntime, activePreviewRuntimeKey, folder]);
  const runtimePreviewSelection = useMemo(
    () => previewSelectionFromRuntime(matchingPreviewRuntime),
    [matchingPreviewRuntime],
  );

  useEffect(() => {
    if (!sessionsHydrated || !latestRuntimePreview) return;
    autoPreviewRuntimeStartedRef.current.add(
      `${activeId}\0${latestRuntimePreview.key}`,
    );
  }, [activeId, sessionsHydrated]);

  useEffect(() => {
    if (
      !latestRuntimePreview ||
      previewAppBusy != null ||
      isPreviewAppActive(previewAppStatus)
    )
      return;
    const autoPreviewKey = `${activeId}\0${latestRuntimePreview.key}`;
    if (autoPreviewRuntimeStartedRef.current.has(autoPreviewKey)) return;
    autoPreviewRuntimeStartedRef.current.add(autoPreviewKey);
    void startPreviewRuntimeForArtifacts(latestRuntimePreview.artifacts);
  }, [activeId, latestRuntimePreview, previewAppBusy, previewAppStatus]);

  useEffect(() => {
    const restoreKey = `${activeId}:${sessionsHydrated ? "hydrated" : "initial"}`;
    if (restoredPreviewThreadRef.current === restoreKey) return;
    restoredPreviewThreadRef.current = restoreKey;
    clearPreviewCloseTimer();
    setPreviewPanelClosing(false);
    if (sidePanelMode === "artifact") {
      if (latestPreviewSelection) {
        setPreviewSelection(latestPreviewSelection);
        setDismissedPreviewKey(null);
      } else {
        setPreviewSelection(null);
        setDismissedPreviewKey(null);
        setSessionSidePanelMode(activeId, null);
      }
    } else if (sidePanelMode === "browser") {
      setPreviewSelection(
        runtimePreviewSelection ?? blankBrowserPreviewSelection(),
      );
      setDismissedPreviewKey(latestPreviewSelection?.autoOpenKey ?? null);
    } else {
      setPreviewSelection(null);
      setDismissedPreviewKey(latestPreviewSelection?.autoOpenKey ?? null);
    }
  }, [activeId, sessionsHydrated]);

  useEffect(() => {
    if (sidePanelMode !== "browser" || !runtimePreviewSelection) return;
    setPreviewSelection((current) => {
      if (
        current?.artifact.mime === "text/uri-list" &&
        current.artifact.content === runtimePreviewSelection.artifact.content
      )
        return current;
      const currentIsBlankBrowser = current?.artifact.id === "artifact-browser";
      const currentIsRuntimeBrowser =
        current?.artifact.id.startsWith("localhost-preview-");
      if (
        current &&
        !currentIsBlankBrowser &&
        !currentIsRuntimeBrowser &&
        current.artifact.content
      )
        return current;
      return runtimePreviewSelection;
    });
  }, [runtimePreviewSelection?.artifact.content, sidePanelMode]);

  useEffect(() => {
    if (
      !latestPreviewSelection ||
      dismissedPreviewKey === latestPreviewSelection.autoOpenKey
    )
      return;
    if (sidePanelMode !== "artifact") {
      setDismissedPreviewKey(latestPreviewSelection.autoOpenKey ?? null);
      return;
    }
    clearPreviewCloseTimer();
    setPreviewPanelClosing(false);
    setPreviewSelection(latestPreviewSelection);
  }, [
    dismissedPreviewKey,
    latestPreviewSelection,
    latestPreviewSelection?.artifact.content,
    sidePanelMode,
  ]);

  function openGitPanel() {
    if (!folder.trim() || (gitStatus && !canOpenGitPanel)) return;
    clearPreviewCloseTimer();
    setPreviewPanelClosing(false);
    setDismissedPreviewKey(latestPreviewSelection?.autoOpenKey ?? null);
    setSessionSidePanelMode(activeId, "git");
  }

  function closeGitPanel() {
    clearPreviewCloseTimer();
    if (prefersReducedMotion()) {
      setPreviewPanelClosing(false);
      setSessionSidePanelOpen(activeId, false);
      return;
    }
    setPreviewPanelClosing(true);
    previewCloseTimeoutRef.current = window.setTimeout(() => {
      if (
        useSessions
          .getState()
          .sessions.find((session) => session.id === activeId)
          ?.sidePanelMode === "git"
      ) {
        setSessionSidePanelOpen(activeId, false);
      }
      setPreviewPanelClosing(false);
      previewCloseTimeoutRef.current = null;
    }, PREVIEW_PANEL_ANIMATION_MS);
  }

  function loadGitActionDraft(text: string) {
    setInput(text);
    setChatNotice({
      tone: "info",
      message: "Git action loaded into composer.",
    });
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')
        ?.focus();
    });
  }

  function closePreview() {
    const closingId = previewArtifact?.id ?? null;
    setDismissedPreviewKey(previewSelection?.autoOpenKey ?? null);
    if (!closingId || prefersReducedMotion()) {
      clearPreviewCloseTimer();
      setPreviewPanelClosing(false);
      setPreviewSelection(null);
      setSessionSidePanelOpen(activeId, false);
      return;
    }
    clearPreviewCloseTimer();
    setPreviewPanelClosing(true);
    previewCloseTimeoutRef.current = window.setTimeout(() => {
      setPreviewSelection((current) =>
        current?.artifact.id === closingId ? null : current,
      );
      const currentMode = useSessions
        .getState()
        .sessions.find((session) => session.id === activeId)?.sidePanelMode;
      if (currentMode === "artifact" || currentMode === "browser")
        setSessionSidePanelOpen(activeId, false);
      setPreviewPanelClosing(false);
      previewCloseTimeoutRef.current = null;
    }, PREVIEW_PANEL_ANIMATION_MS);
  }

  function openPreviewArtifact(
    artifact: ChatArtifact,
    artifacts?: readonly ChatArtifact[],
    previewDeferred = false,
    revision?: ArtifactRevision,
  ) {
    clearPreviewCloseTimer();
    setPreviewPanelClosing(false);
    setDismissedPreviewKey(latestPreviewSelection?.autoOpenKey ?? null);
    setSessionSidePanelMode(
      activeId,
      sidePanelModeForArtifact(revision?.artifact ?? artifact),
    );
    const choice = revision
      ? artifactRevisionChoice(revision.messageIndex, revision.artifactIndex)
      : undefined;
    setPreviewSelection({
      artifact: revision?.artifact ?? artifact,
      artifacts: [
        ...(revision?.artifacts ??
          (artifacts?.length ? artifacts : [artifact])),
      ],
      revision,
      revisionGroup: choice?.group,
      previewDeferred,
    });
  }

  function openArtifactBrowser() {
    const selection = runtimePreviewSelection;
    if (selection) {
      openPreviewArtifact(selection.artifact, selection.artifacts);
      return;
    }
    openPreviewArtifact(blankBrowserArtifact());
  }

  async function startPreviewRuntimeForArtifacts(
    artifacts?: readonly ChatArtifact[],
  ) {
    const files = previewRuntimeFiles(artifacts);
    if (!files.length) {
      setChatNotice({
        tone: "error",
        message: "Preview runtime needs named artifact files.",
      });
      return;
    }
    const runtimeFiles = folder.trim() ? files : virtualRuntimeFilesWith(files);
    if (!hasPreviewPackageJson(runtimeFiles)) {
      setChatNotice({
        tone: "error",
        message: "Preview runtime needs a named package.json artifact.",
      });
      return;
    }
    setPreviewAppBusy("start");
    try {
      if (!folder.trim()) upsertVirtualFiles(activeId, files);
      await stagePreviewApp(activePreviewRuntimeKey, runtimeFiles);
      const status = await startPreviewApp(activePreviewRuntimeKey);
      setPreviewAppStatus(status);
      persistPreviewRuntimeStatus(status);
      const url = previewRuntimeBrowserUrl(status);
      openPreviewArtifact(
        url ? localhostPreviewArtifact(url) : blankBrowserArtifact(),
      );
      setSessionSidePanelMode(activeId, "browser");
      setSessionSidePanelOpen(activeId, true);
    } catch (error) {
      setChatNotice({
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPreviewAppBusy(null);
    }
  }

  async function startPreviewRuntime() {
    setPreviewAppBusy("start");
    try {
      if (!folder.trim()) {
        const files = currentVirtualProjectFiles();
        if (files.length && hasPreviewPackageJson(files))
          await stagePreviewApp(activePreviewRuntimeKey, files);
      }
      const status = await startPreviewApp(
        activePreviewRuntimeKey,
        previewRuntimeStartOptions(folder),
      );
      setPreviewAppStatus(status);
      persistPreviewRuntimeStatus(status);
      const url = previewRuntimeBrowserUrl(status);
      if (url) openPreviewArtifact(localhostPreviewArtifact(url));
      else if (sidePanelMode === "browser")
        openPreviewArtifact(blankBrowserArtifact());
    } catch (error) {
      setChatNotice({
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPreviewAppBusy(null);
    }
  }

  async function stopPreviewRuntime() {
    setPreviewAppBusy("stop");
    try {
      const status = await stopPreviewApp(activePreviewRuntimeKey);
      setPreviewAppStatus(status);
      persistPreviewRuntimeStatus(status);
    } catch (error) {
      setChatNotice({
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPreviewAppBusy(null);
    }
  }

  async function restartPreviewRuntime() {
    setPreviewAppBusy("restart");
    try {
      let status: PreviewAppStatus;
      const files = !folder.trim()
        ? currentVirtualProjectFiles()
        : latestRuntimePreview
          ? previewRuntimeFiles(latestRuntimePreview.artifacts)
          : [];
      if (!folder.trim() && files.length && hasPreviewPackageJson(files)) {
        await stopPreviewApp(activePreviewRuntimeKey).catch(() => undefined);
        await stagePreviewApp(activePreviewRuntimeKey, files);
        status = await startPreviewApp(activePreviewRuntimeKey);
      } else if (files.length && hasPreviewPackageJson(files)) {
        await stopPreviewApp(activePreviewRuntimeKey).catch(() => undefined);
        await stagePreviewApp(activePreviewRuntimeKey, files);
        status = await startPreviewApp(activePreviewRuntimeKey);
      } else {
        status = await restartPreviewApp(
          activePreviewRuntimeKey,
          previewRuntimeStartOptions(folder),
        );
      }
      setPreviewAppStatus(status);
      persistPreviewRuntimeStatus(status);
      const url = previewRuntimeBrowserUrl(status);
      openPreviewArtifact(
        url ? localhostPreviewArtifact(url) : blankBrowserArtifact(),
      );
    } catch (error) {
      setChatNotice({
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPreviewAppBusy(null);
    }
  }

  function openArtifactSidePanel() {
    const selection =
      latestPreviewSelection ??
      (sidePanelMode === "artifact" ? previewSelection : null);
    if (!selection) return;
    clearPreviewCloseTimer();
    setPreviewPanelClosing(false);
    setSessionSidePanelMode(activeId, "artifact");
    setDismissedPreviewKey(null);
    setPreviewSelection(selection);
  }

  function openSelectedSidePanel() {
    if (sidePanelMode === "git" && (canOpenGitPanel || gitPanelChecking)) {
      openGitPanel();
    } else if (
      sidePanelMode === "artifact" &&
      (latestPreviewSelection || previewSelection)
    ) {
      openArtifactSidePanel();
    } else {
      openArtifactBrowser();
    }
  }

  function selectPreviewRevision(revision: ArtifactRevision) {
    const choice = artifactRevisionChoice(
      revision.messageIndex,
      revision.artifactIndex,
    );
    setPreviewSelection((current) =>
      current
        ? {
            ...current,
            artifact: revision.artifact,
            artifacts: [...revision.artifacts],
            revision,
            revisionGroup: choice?.group ?? current.revisionGroup,
          }
        : current,
    );
  }

  const resolvedPreviewPanelWidth = clampPreviewPanelWidth(previewPanelWidth);
  const previewPanelStyle = {
    "--preview-panel-width": `${resolvedPreviewPanelWidth}px`,
  } as CSSProperties;
  const visiblePreviewSelection =
    previewSelection ??
    (sidePanelOpen && sidePanelMode === "browser"
      ? (runtimePreviewSelection ?? blankBrowserPreviewSelection())
      : sidePanelOpen && sidePanelMode === "artifact"
        ? latestPreviewSelection
        : null);
  const sidePanelVisible = Boolean(
    sidePanelOpen &&
    sidePanelMode &&
    (sidePanelMode === "git" ? canShowGitPanel : visiblePreviewSelection),
  );
  const sidePanelAlreadyOpen =
    sidePanelOpenRef.current && sidePanelVisible && !previewPanelClosing;

  useEffect(() => {
    sidePanelOpenRef.current = sidePanelVisible;
  }, [sidePanelVisible]);

  function resizePreviewPanel(width: number) {
    setPreviewPanelWidth(clampPreviewPanelWidth(width));
  }

  function startPreviewResize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    previewResizeStartRef.current = {
      clientX: event.clientX,
      width: resolvedPreviewPanelWidth,
    };
    setPreviewResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function movePreviewResize(event: PointerEvent<HTMLDivElement>) {
    const start = previewResizeStartRef.current;
    if (!start) return;
    resizePreviewPanel(start.width + start.clientX - event.clientX);
  }

  function endPreviewResize(event: PointerEvent<HTMLDivElement>) {
    if (!previewResizeStartRef.current) return;
    previewResizeStartRef.current = null;
    setPreviewResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function resizePreviewWithKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      resizePreviewPanel(
        resolvedPreviewPanelWidth + PREVIEW_PANEL_KEYBOARD_STEP,
      );
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      resizePreviewPanel(
        resolvedPreviewPanelWidth - PREVIEW_PANEL_KEYBOARD_STEP,
      );
    } else if (event.key === "Home") {
      event.preventDefault();
      resizePreviewPanel(PREVIEW_PANEL_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      resizePreviewPanel(maxPreviewPanelWidth());
    }
  }

  function requireChatModel(): string | null {
    const selected = effectiveModel.trim();
    if (selected) return selected;
    setChatNotice({
      tone: "error",
      message:
        "Choose a model before sending. Add Ollama, LM Studio, or another provider in Providers.",
    });
    setProvidersOpen(true);
    return null;
  }

  function sessionMessages(
    sessionId: string,
    fallback: ChatMessage[] = [],
  ): ChatMessage[] {
    return (
      useSessions
        .getState()
        .sessions.find((session) => session.id === sessionId)?.messages ??
      fallback
    );
  }

  async function maybeGenerateAiThreadTitle(
    sessionId: string,
    turnModel: string,
  ): Promise<void> {
    const prefs = useUiPreferences.getState();
    if (!prefs.autoTitleChats || !prefs.aiThreadNames) return;
    const session = useSessions
      .getState()
      .sessions.find((item) => item.id === sessionId);
    if (
      !session ||
      session.messages.filter((message) => message.role === "user").length !== 1
    )
      return;
    if (!shouldReplaceThreadTitle(session.title, session.messages)) return;
    const namingModel = (prefs.aiThreadNameModel || turnModel).trim();
    const namingModelInfo = pickerModels.find(
      (item) => item.id === namingModel,
    );
    if (!isThreadNamingModel(namingModelInfo ?? namingModel)) {
      console.info(
        "AI thread naming skipped: choose a provider chat model for Codex, Claude, or media chats.",
      );
      return;
    }
    const firstUser = session.messages.find(
      (message) => message.role === "user",
    );
    const firstAssistant = session.messages.find(
      (message) => message.role === "assistant" && message.content.trim(),
    );
    if (!firstUser || !firstAssistant) return;
    let rawTitle: string;
    try {
      rawTitle = await completeChat(
        namingModel,
        [
          { role: "system", content: AI_THREAD_TITLE_SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              `User: ${compactText(wireMessageContent(firstUser), 700)}`,
              `Assistant: ${compactText(firstAssistant.content, 700)}`,
            ].join("\n"),
          },
        ],
        { maxTokens: 16, temperature: 0 },
      );
    } catch (error) {
      console.warn(
        `AI thread naming failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const title = sanitizeAiThreadTitle(rawTitle);
    if (!title) {
      console.info(
        "AI thread naming skipped: model returned an unusable title.",
      );
      return;
    }
    const latest = useSessions
      .getState()
      .sessions.find((item) => item.id === sessionId);
    if (
      latest &&
      latest.messages.filter((message) => message.role === "user").length ===
        1 &&
      shouldReplaceThreadTitle(latest.title, latest.messages)
    ) {
      useSessions.getState().rename(sessionId, title);
    }
  }

  async function createCompactionCheckpoint(
    _sessionId: string,
    sourceMessages: ChatMessage[],
    model: string,
    options: {
      auto: boolean;
      folder: string;
      reasoningEffort: ReasoningEffort;
      signal?: AbortSignal;
    },
  ): Promise<ChatMessage> {
    const sourceContext = messagesForModelContext([], sourceMessages);
    if (!sourceContext.some((message) => wireMessageContent(message).trim())) {
      throw new Error("There is no thread context to compact.");
    }
    const baseline = summarizeThreadMetricsBreakdown(sourceMessages).lifetime;
    const codexModel = codexRuntimeModel(model);
    const claudeModel = claudeRuntimeModel(model);
    const summaryStartedAt = Date.now();
    const selectedProvider = providers.find(
      (item) => item.enabled && item.models.includes(model),
    );
    const provider = codexModel
      ? "Codex"
      : claudeModel
        ? "Claude Code"
        : selectedProvider?.name;
    const summaryReasoningEffort =
      compactionSummaryReasoningEffort(selectedProvider);
    let usage: TokenUsage | undefined;
    let costUsd: number | undefined;
    let lastError = "Compaction failed.";

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = attempt > 0;
      const outputCapTokens = compactionSummaryOutputCap(
        model,
        pickerModels,
        retry,
      );
      const promptMessages = compactionSummaryMessages(
        sourceMessages,
        model,
        pickerModels,
        { retry, outputCapTokens },
      );
      let summary: CompactionSummaryResult;
      if (codexModel) {
        const ready = await ensureCodexAccount();
        if (!ready.ok) throw new Error(ready.message);
        summary = await summarizeWithCodex(
          codexModel,
          promptMessages,
          options.folder,
          options.reasoningEffort,
          options.signal,
        );
      } else if (claudeModel) {
        const ready = await ensureClaudeAccount();
        if (!ready.ok) throw new Error(ready.message);
        summary = await summarizeWithClaude(
          claudeModel,
          promptMessages,
          options.folder,
          options.reasoningEffort,
          options.signal,
        );
      } else {
        const completion = await completeChatWithMetrics(
          model,
          promptMessages,
          {
            maxTokens: outputCapTokens,
            temperature: 0,
            reasoningEffort: summaryReasoningEffort,
            signal: options.signal,
          },
        );
        summary = {
          content: completion.content,
          usage: completion.usage,
          finishReason: completion.finishReason,
          costUsd: estimateResponseCostUsd(model, completion.usage, providers),
        };
      }

      usage = mergeTokenUsage(usage, summary.usage);
      if (typeof summary.costUsd === "number")
        costUsd = (costUsd ?? 0) + summary.costUsd;

      const clean = summary.content.trim();
      const validationError = validateCompactionCheckpointSummary(clean, {
        finishReason: summary.finishReason,
        model,
        models: pickerModels,
        sourceMessages,
      });
      if (!validationError) {
        return checkpointMessage(clean, {
          auto: options.auto,
          sourceTokens: estimateMessagesTokens(sourceContext),
          baseline,
          summaryMetrics: {
            model,
            provider,
            durationMs: Date.now() - summaryStartedAt,
            usage,
            costUsd,
          },
        });
      }
      lastError = validationError;
    }

    throw new Error(lastError);
  }

  async function summarizeWithCodex(
    model: string,
    promptMessages: ChatMessage[],
    folder: string,
    reasoningEffort: ReasoningEffort,
    signal?: AbortSignal,
  ): Promise<CompactionSummaryResult> {
    let text = "";
    let error: string | null = null;
    let warning: string | null = null;
    let usage: TokenUsage | undefined;
    let costUsd: number | undefined;
    await streamCodexRun(
      codexCompactionSummaryRequest({
        model,
        prompt: codexPromptFromMessages(promptMessages),
        cwd: folder.trim() || undefined,
        reasoningEffort,
      }),
      (ev: CodexRunEvent) => {
        if (ev.type === "token" && ev.text) text += ev.text;
        else if (ev.type === "warning") warning = ev.message;
        else if (ev.type === "error") error = ev.message;
        else if (ev.type === "done") {
          usage = ev.usage;
          costUsd =
            typeof ev.cost_usd === "number" && ev.cost_usd > 0
              ? ev.cost_usd
              : undefined;
        }
      },
      signal,
    );
    if (error) throw new Error(error);
    if (warning) throw new Error(warning);
    return { content: text, usage, costUsd };
  }

  async function summarizeWithClaude(
    model: string,
    promptMessages: ChatMessage[],
    folder: string,
    reasoningEffort: ReasoningEffort,
    signal?: AbortSignal,
  ): Promise<CompactionSummaryResult> {
    let text = "";
    let error: string | null = null;
    let warning: string | null = null;
    let usage: TokenUsage | undefined;
    let costUsd: number | undefined;
    await streamClaudeRun(
      claudeCompactionSummaryRequest({
        model,
        prompt: codexPromptFromMessages(promptMessages),
        cwd: folder.trim() || undefined,
        reasoningEffort,
      }),
      (ev: ClaudeRunEvent) => {
        if (ev.type === "token" && ev.text) text += ev.text;
        else if (ev.type === "warning") warning = ev.message;
        else if (ev.type === "error") error = ev.message;
        else if (ev.type === "done") {
          usage = ev.usage;
          costUsd =
            typeof ev.cost_usd === "number" && ev.cost_usd > 0
              ? ev.cost_usd
              : undefined;
        }
      },
      signal,
    );
    if (error) throw new Error(error);
    if (warning) throw new Error(warning);
    return { content: text, usage, costUsd };
  }

  async function compactThreadManually() {
    if (busy || compactionInFlightRef.current) {
      setChatNotice({
        tone: "info",
        message: "Wait for the current run to finish before compacting.",
      });
      return;
    }
    if (activeMediaTarget) {
      setChatNotice({
        tone: "error",
        message: "Switch to a chat model before compacting context.",
      });
      return;
    }
    const selectedModel = requireChatModel();
    if (!selectedModel) return;
    const currentMessages =
      useSessions.getState().sessions.find((session) => session.id === activeId)
        ?.messages ?? messages;
    if (!currentMessages.length) {
      setChatNotice({
        tone: "info",
        message: "There is no thread context to compact.",
      });
      return;
    }
    compactionInFlightRef.current = true;
    setChatNotice({ tone: "info", message: "Compacting thread context..." });
    try {
      const reasoningEffort = reasoningEffortForModel(
        useSettings.getState().reasoningEffortByModel,
        selectedModel,
        pickerModels,
      );
      const split = splitCompactionTail(
        currentMessages,
        selectedModel,
        pickerModels,
      );
      const checkpoint = await createCompactionCheckpoint(
        activeId,
        split.head,
        selectedModel,
        {
          auto: false,
          folder,
          reasoningEffort,
        },
      );
      const store = useSessions.getState();
      store.setMessages(activeId, [...split.head, checkpoint, ...split.tail], {
        autoTitle: false,
      });
      store.clearAccountRuntime(activeId);
      setChatNotice({
        tone: "info",
        message:
          "Context checkpoint created. Future replies start from the summary.",
      });
      focusComposer();
    } catch (e) {
      setChatNotice({
        tone: "error",
        message: `Compaction failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      compactionInFlightRef.current = false;
    }
  }

  function sessionGoal(sessionId: string): GoalSettings {
    return useSessions.getState().getSettings(sessionId).goal;
  }

  function updateGoalState(
    sessionId: string,
    patch: Partial<GoalSettings>,
    baseGoal = sessionGoal(sessionId),
  ): GoalSettings {
    const next = normalizeGoalSettings({
      ...baseGoal,
      ...patch,
      updatedAt: Date.now(),
    });
    useSessions.getState().updateSettings(sessionId, { goal: next });
    return next;
  }

  async function drainQueuedMessages(
    sessionId: string,
    fallbackModel?: string,
  ) {
    return drainQueuedMessagesFromQueue({
      sessionId,
      fallbackModel,
      queueDrainRef,
      generationControllersRef,
      agents: useAgents.getState().agents,
      setChatNotice,
      sessionMessages,
      runTurn: (convo, selectedModel, targetSessionId) =>
        runTurn(convo, selectedModel, {}, targetSessionId),
    });
  }

  async function runTurnAndDrain(
    convo: ChatMessage[],
    selectedModel?: string,
    options: RunTurnOptions = {},
  ) {
    const sessionId = activeId;
    const result = await runTurn(convo, selectedModel, options, sessionId);
    if (result.status === "done") {
      await drainQueuedMessages(sessionId, selectedModel);
    }
    return result;
  }

  function pauseGoalRun(reason = "Goal paused.", sessionId = activeId) {
    const loop = goalLoopRef.current;
    if (loop?.sessionId === sessionId) {
      loop.stopped = true;
      loop.decisionController?.abort();
    }
    generationControllersRef.current.get(sessionId)?.abort();
    const current = sessionGoal(sessionId);
    if (current.status === "running") {
      updateGoalState(
        sessionId,
        { status: "paused", lastReason: reason },
        current,
      );
    }
  }

  function draftToGoal(
    draft: GoalPanelDraft,
    current: GoalSettings,
  ): GoalSettings {
    const contentChanged =
      draft.objective !== current.objective ||
      draft.successCriteria !== current.successCriteria ||
      draft.constraints !== current.constraints;
    const status = !draft.objective.trim()
      ? "idle"
      : current.status === "running"
        ? "paused"
        : contentChanged &&
            (current.status === "complete" ||
              current.status === "blocked" ||
              current.status === "error")
          ? "paused"
          : current.status;
    return normalizeGoalSettings({
      ...current,
      objective: draft.objective,
      successCriteria: draft.successCriteria,
      constraints: draft.constraints,
      developerMaxTurns: draft.developerMaxTurns,
      status,
      lastReason:
        current.status === "running"
          ? "Goal paused for edits."
          : current.lastReason,
      updatedAt: Date.now(),
    });
  }

  function saveGoalDraft(
    draft: GoalPanelDraft,
    sessionId = activeId,
  ): GoalSettings {
    const current = sessionGoal(sessionId);
    if (current.status === "running")
      pauseGoalRun("Goal paused for edits.", sessionId);
    const next = draftToGoal(draft, current);
    useSessions.getState().updateSettings(sessionId, { goal: next });
    setGoalPrefill(null);
    return next;
  }

  function deleteGoal(sessionId = activeId) {
    pauseGoalRun("Goal deleted.", sessionId);
    useSessions
      .getState()
      .updateSettings(sessionId, { goal: DEFAULT_GOAL_SETTINGS });
    setGoalPrefill(null);
    setGoalPanelOpen(false);
  }

  function markGoalSeen(sessionId = activeId) {
    const current = sessionGoal(sessionId);
    const updatedAt = current.updatedAt ?? 0;
    if (!updatedAt || (current.lastSeenAt ?? 0) >= updatedAt) return;
    useSessions
      .getState()
      .updateSettings(sessionId, {
        goal: { ...current, lastSeenAt: Date.now() },
      });
  }

  function openGoalPanel(prefill: string | null = null) {
    setGoalPrefill(prefill);
    markGoalSeen();
    setGoalPanelOpen(true);
    setChatNotice(null);
  }

  function requestToolApprovalCard(
    sessionId: string,
    convo: ChatMessage[],
    selectedModel: string,
    scope: ToolApprovalScope,
  ) {
    const next = [
      ...convo.filter(
        (message) =>
          !(
            message.approval?.scope === scope &&
            message.approval.status === "pending"
          ),
      ),
      toolApprovalMessage(scope, selectedModel),
    ];
    setMessages(sessionId, next, { autoTitle: autoTitleChats });
    setChatNotice({
      tone: "info",
      message:
        scope === "goal"
          ? "Goal waiting for tool approval."
          : "Reply waiting for tool approval.",
    });
  }

  function updateApprovalAt(
    messageIndex: number,
    status: "approved" | "denied",
    sessionId = activeId,
  ): ChatMessage[] {
    const latest = sessionMessages(sessionId);
    if (!latest[messageIndex]?.approval) return latest;
    const next = latest.map((message, index) =>
      index === messageIndex
        ? resolveApprovalMessage(message, status)
        : message,
    );
    setMessages(sessionId, next, { autoTitle: false });
    return next;
  }

  function startApprovedGoalRun(sessionId: string, selectedModel: string) {
    if (goalLoopRef.current && !goalLoopRef.current.stopped) return;
    const savedGoal = sessionGoal(sessionId);
    if (!goalConfigured(savedGoal)) {
      openGoalPanel();
      setChatNotice({
        tone: "info",
        message: "Add a goal objective before running.",
      });
      return;
    }
    const now = Date.now();
    const runningGoal = normalizeGoalSettings({
      ...savedGoal,
      status: "running",
      lastReason:
        savedGoal.status === "paused" ? "Goal resumed." : "Goal run started.",
      startedAt: savedGoal.startedAt ?? now,
      updatedAt: now,
    });
    useSessions.getState().updateSettings(sessionId, { goal: runningGoal });
    goalLoopRef.current = { sessionId, stopped: false };
    setGoalPrefill(null);
    setGoalPanelOpen(false);
    setChatNotice({ tone: "info", message: "Goal running." });
    void runGoalLoop(sessionId, selectedModel, runningGoal, true);
  }

  function approveToolApproval(messageIndex: number, message: ChatMessage) {
    const approval = message.approval;
    if (!approval || approval.status !== "pending" || busy || activeMediaTarget)
      return;
    const selectedModel = approval.model || requireChatModel();
    if (!selectedModel) return;
    const approvedMessages = updateApprovalAt(messageIndex, "approved");
    if (approval.scope === "goal") {
      startApprovedGoalRun(activeId, selectedModel);
      return;
    }
    setChatNotice({
      tone: "info",
      message: "Tool access approved for this reply.",
    });
    void runTurnAndDrain(approvedMessages, selectedModel, {
      toolApprovalGrant: true,
    });
  }

  function denyToolApproval(messageIndex: number, message: ChatMessage) {
    const approval = message.approval;
    if (!approval || approval.status !== "pending" || busy) return;
    updateApprovalAt(messageIndex, "denied");
    if (approval.scope === "goal") {
      updateGoalState(activeId, {
        status: "paused",
        lastReason: "Goal run canceled before tool approval.",
      });
    }
    setChatNotice({ tone: "info", message: "Tool access denied." });
  }

  async function requestGoalDecision(
    sessionId: string,
    turnModel: string,
    currentGoal: GoalSettings,
    latestMessages: ChatMessage[],
  ): Promise<GoalDecision> {
    const controller = new AbortController();
    const loop = goalLoopRef.current;
    if (loop?.sessionId === sessionId) loop.decisionController = controller;
    try {
      const decisionMessages = goalDecisionMessages(
        currentGoal,
        latestMessages,
      );
      const decisionReasoningEffort = reasoningEffortForModel(
        useSettings.getState().reasoningEffortByModel,
        turnModel,
        pickerModels,
      );
      const codexModel = codexRuntimeModel(turnModel);
      const claudeModel = claudeRuntimeModel(turnModel);
      let content = "";
      if (codexModel) {
        let codexError: string | null = null;
        let codexWarning: string | null = null;
        await streamCodexRun(
          {
            model: codexModel,
            prompt: codexPromptFromMessages(decisionMessages),
            cwd: folder.trim() || undefined,
            reasoning_effort: decisionReasoningEffort,
            tool_approval_policy: "review",
            tool_approval_grant: false,
            plan_mode: false,
          },
          (ev: CodexRunEvent) => {
            if (ev.type === "token" && ev.text) content += ev.text;
            else if (ev.type === "warning") codexWarning = ev.message;
            else if (ev.type === "error") codexError = ev.message;
          },
          controller.signal,
        );
        if (codexWarning) throw new Error(codexWarning);
        if (codexError) throw new Error(codexError);
      } else if (claudeModel) {
        let claudeError: string | null = null;
        let claudeWarning: string | null = null;
        await streamClaudeRun(
          {
            model: claudeModel,
            prompt: codexPromptFromMessages(decisionMessages),
            cwd: folder.trim() || undefined,
            reasoning_effort: decisionReasoningEffort,
            tool_approval_policy: "review",
            tool_approval_grant: false,
            plan_mode: false,
          },
          (ev: ClaudeRunEvent) => {
            if (ev.type === "token" && ev.text) content += ev.text;
            else if (ev.type === "warning") claudeWarning = ev.message;
            else if (ev.type === "error") claudeError = ev.message;
          },
          controller.signal,
        );
        if (claudeWarning) throw new Error(claudeWarning);
        if (claudeError) throw new Error(claudeError);
      } else {
        content = await completeChat(turnModel, decisionMessages, {
          signal: controller.signal,
          maxTokens: 500,
          temperature: 0,
        });
      }
      return parseGoalDecision(content);
    } finally {
      if (goalLoopRef.current?.decisionController === controller) {
        goalLoopRef.current.decisionController = undefined;
      }
    }
  }

  function goalConversation(
    sessionId: string,
    currentGoal: GoalSettings,
    nextPrompt?: string,
  ): ChatMessage[] {
    const latest = sessionMessages(sessionId);
    const last = latest[latest.length - 1];
    if (last?.role === "user") return latest;
    return [
      ...latest,
      {
        role: "user",
        content: goalContinuationPrompt(
          currentGoal,
          nextPrompt ?? currentGoal.nextPrompt,
        ),
      },
    ];
  }

  async function runGoalLoop(
    sessionId: string,
    selectedModel: string,
    initialGoal: GoalSettings,
    toolApprovalGrant?: boolean,
  ) {
    const loop = goalLoopRef.current;
    let currentGoal = initialGoal;
    try {
      for (;;) {
        if (!loop || loop.stopped) return;
        currentGoal = sessionGoal(sessionId);
        if (currentGoal.status !== "running") return;
        if (
          currentGoal.developerMaxTurns &&
          currentGoal.turns >= currentGoal.developerMaxTurns
        ) {
          updateGoalState(
            sessionId,
            {
              status: "paused",
              lastReason: "Developer max-turn cap reached.",
            },
            currentGoal,
          );
          return;
        }

        const turnResult = await runTurn(
          goalConversation(sessionId, currentGoal),
          selectedModel,
          {
            goal: currentGoal,
            toolApprovalGrant,
          },
          sessionId,
        );
        if (loop.stopped) return;
        if (turnResult.status === "aborted") {
          updateGoalState(sessionId, {
            status: "paused",
            lastReason: "Goal paused.",
          });
          return;
        }
        if (turnResult.status !== "done") {
          updateGoalState(sessionId, {
            status: turnResult.status === "skipped" ? "paused" : "error",
            lastReason:
              turnResult.error || "Goal run stopped before the turn completed.",
          });
          return;
        }
        if (loop.stopped) {
          updateGoalState(sessionId, {
            status: "paused",
            lastReason: "Goal paused.",
          });
          return;
        }
        if (hasQueuedMessages(sessionId)) {
          updateGoalState(sessionId, {
            status: "paused",
            lastReason: "Goal paused for queued user messages.",
          });
          await drainQueuedMessages(sessionId, selectedModel);
          return;
        }

        const decision = await requestGoalDecision(
          sessionId,
          selectedModel,
          currentGoal,
          turnResult.messages,
        );
        const afterDecisionGoal = sessionGoal(sessionId);
        currentGoal = updateGoalState(
          sessionId,
          applyGoalDecision(afterDecisionGoal, decision),
          afterDecisionGoal,
        );
        if (currentGoal.status !== "running") return;
      }
    } catch (e) {
      if (loop?.stopped) return;
      const aborted = e instanceof DOMException && e.name === "AbortError";
      updateGoalState(sessionId, {
        status: aborted ? "paused" : "error",
        lastReason: aborted
          ? "Goal paused."
          : `Goal controller failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      if (goalLoopRef.current === loop) goalLoopRef.current = null;
    }
  }

  function startGoalRun(draft?: GoalPanelDraft) {
    if (activeMediaTarget) {
      setChatNotice({
        tone: "error",
        message: "Switch back to chat before running a goal.",
      });
      return;
    }
    const selectedModel = requireChatModel();
    if (!selectedModel) return;
    const sessionId = activeId;
    if (goalLoopRef.current && !goalLoopRef.current.stopped) return;
    const savedGoal = draft
      ? saveGoalDraft(draft, sessionId)
      : sessionGoal(sessionId);
    if (!goalConfigured(savedGoal)) {
      openGoalPanel();
      setChatNotice({
        tone: "info",
        message: "Add a goal objective before running.",
      });
      return;
    }
    if (toolApproval === "review") {
      updateGoalState(
        sessionId,
        { status: "paused", lastReason: "Goal waiting for tool approval." },
        savedGoal,
      );
      requestToolApprovalCard(
        sessionId,
        sessionMessages(sessionId),
        selectedModel,
        "goal",
      );
      return;
    }
    startApprovedGoalRun(sessionId, selectedModel);
  }

  function stopSpeech(clearState = true) {
    if (!speechRef.current) return;
    speechRef.current.audio.pause();
    URL.revokeObjectURL(speechRef.current.url);
    speechRef.current = null;
    if (clearState) setSpeakingIndex(null);
  }

  async function speakMessage(index: number, text: string) {
    if (!ttsReady || !text.trim()) return;
    if (speakingIndex === index) {
      stopSpeech();
      return;
    }
    stopSpeech();
    setSpeakingIndex(index);
    try {
      const blob = await speakText(text, voice);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      speechRef.current = { audio, url };
      audio.onended = () => stopSpeech();
      audio.onerror = () => stopSpeech();
      await audio.play();
    } catch (e) {
      stopSpeech();
      setChatNotice({
        tone: "error",
        message: `Text-to-speech failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  async function handleSaveArtifact(
    messageIndex: number,
    artifact: ChatArtifact,
    options?: {
      overwrite?: boolean;
      path?: string;
      source?: SavedArtifactFile["source"];
    },
    revision?: ArtifactRevision,
  ): Promise<SavedArtifactFile> {
    const target =
      options?.path?.trim() || (artifact.filename ?? artifact.title);
    const targetMessageIndex = revision?.messageIndex ?? messageIndex;
    const targetMessage = useSessions
      .getState()
      .sessions.find((s) => s.id === activeId)?.messages[targetMessageIndex];
    const targetMessageId = targetMessage?.id ?? targetMessageIndex;
    if (!folder.trim()) {
      const path = normalizeVirtualFilePath(target);
      if (!path) throw new Error("virtual project file path must be relative");
      const existing = currentVirtualFile(path);
      if (existing && !options?.overwrite)
        throw new Error("file already exists in virtual project");
      const saved: SavedArtifactFile = {
        path,
        bytes: textBytes(artifact.content),
        overwritten: Boolean(existing),
        savedAt: Date.now(),
        sourceSessionId: APP_SESSION_ID,
        sourceMessageIndex: targetMessageIndex,
        sourceRevisionNumber: revision?.revisionNumber,
        source: options?.source ?? "artifact",
      };
      upsertVirtualFiles(activeId, [{ path, content: artifact.content }], {
        sourceMessageIndex: targetMessageIndex,
        sourceRevisionNumber: revision?.revisionNumber,
      });
      markArtifactSaved(activeId, targetMessageId, artifact.id, saved);
      return saved;
    }
    const saved = await saveArtifactFile(
      folder,
      target,
      artifact.content,
      options?.overwrite ?? false,
    );
    const tracedSaved: SavedArtifactFile = {
      ...saved,
      savedAt: Date.now(),
      sourceSessionId: APP_SESSION_ID,
      sourceMessageIndex: targetMessageIndex,
      sourceRevisionNumber: revision?.revisionNumber,
      source: options?.source ?? "artifact",
    };
    markArtifactSaved(activeId, targetMessageId, artifact.id, tracedSaved);
    if (options?.source === "auto_artifact") {
      const message = useSessions
        .getState()
        .sessions.find((s) => s.id === activeId)?.messages[targetMessageIndex];
      if (message?.streamParts?.length && message.id) {
        useSessions.getState().appendStreamEvent(activeId, message.id, {
          kind: "event",
          eventType: "tool",
          label: "Created file",
          detail: target,
          icon: "file",
          name: "write_file",
          status: "done",
        });
      }
    }
    return tracedSaved;
  }

  async function handlePreviewArtifact(
    artifact: ChatArtifact,
    path?: string,
    _revision?: ArtifactRevision,
  ): Promise<ArtifactWritePreview> {
    const target = path?.trim() || (artifact.filename ?? artifact.title);
    if (!folder.trim()) {
      const normalized = normalizeVirtualFilePath(target);
      if (!normalized)
        throw new Error("virtual project file path must be relative");
      return virtualArtifactPreview(
        normalized,
        artifact.content,
        currentVirtualFile(normalized),
      );
    }
    return await previewArtifactFile(folder, target, artifact.content);
  }

  async function handleOpenArtifact(
    saved: SavedArtifactFile,
    target: ArtifactOpenTarget,
  ) {
    if (!folder.trim()) {
      const file = currentVirtualFile(saved.path);
      if (!file) throw new Error("virtual project file is unavailable");
      openPreviewArtifact(virtualChatArtifact(file), [
        virtualChatArtifact(file),
      ]);
      if (target === "folder")
        setChatNotice({
          tone: "info",
          message: "Opened the virtual project file.",
        });
      return;
    }
    await openArtifactLocation(saved.path, target);
  }

  async function handleCheckArtifact(
    saved: SavedArtifactFile,
  ): Promise<ArtifactFileStatus> {
    if (!folder.trim()) {
      const file = currentVirtualFile(saved.path);
      return {
        path: saved.path,
        exists: Boolean(file),
        is_file: Boolean(file),
        is_dir: false,
        bytes: file?.bytes ?? null,
      };
    }
    return await artifactFileStatus(saved.path);
  }

  async function openFolderPicker(): Promise<string | null> {
    if (!inTauri) {
      setChatNotice({
        tone: "info",
        message:
          "Folder picker is available in the desktop app. Use /folder <path> to set a folder here.",
      });
      return null;
    }
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({ directory: true, multiple: false });
      return typeof sel === "string" ? sel : null;
    } catch {
      /* dialog unavailable */
    }
    return null;
  }

  async function pickFolder() {
    const selected = await openFolderPicker();
    if (selected) updateThreadSettings(activeId, { folder: selected });
  }

  function startChatInFolder(nextFolder: string) {
    const store = useSessions.getState();
    store.newChat({ ...store.getSettings(store.activeId), folder: nextFolder });
    setChatNotice(null);
    focusComposer();
  }

  async function pickProjectFolder() {
    const selected = await openFolderPicker();
    if (selected) startChatInFolder(selected);
  }

  async function handleAttachFiles(files?: File[]) {
    try {
      let next: ChatAttachment[] = [];
      if (files?.length) {
        next = await Promise.all(files.map(browserFileAttachment));
      } else if (inTauri) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ directory: false, multiple: true });
        const paths = Array.isArray(selected)
          ? selected
          : typeof selected === "string"
            ? [selected]
            : [];
        next = await Promise.all(
          paths.map(async (path) => ({
            id: attachmentId(),
            ...(await readAttachmentFile(path)),
          })),
        );
      }
      if (next.length)
        setPendingAttachments((current) => [...current, ...next].slice(0, 12));
    } catch (e) {
      setChatNotice({
        tone: "error",
        message: `Could not attach file: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  async function handleAttachWorkspaceFile(
    file: WorkspaceFileSuggestion,
  ): Promise<boolean> {
    try {
      const next = {
        id: attachmentId(),
        ...(await readAttachmentFile(file.full_path)),
      };
      setPendingAttachments((current) => [...current, next].slice(0, 12));
      return true;
    } catch (e) {
      setChatNotice({
        tone: "error",
        message: `Could not attach file: ${e instanceof Error ? e.message : String(e)}`,
      });
      return false;
    }
  }

  function slashCommandFeature(id: string): FeatureId | null {
    switch (id) {
      case "folder":
        return "workspace";
      case "sandbox":
      case "nosandbox":
        return "sandbox";
      case "computer":
      case "nocomputer":
        return "computerUse";
      case "agent":
        return "agents";
      default:
        return null;
    }
  }

  function exportSessionById(
    sessionId = activeId,
    format: ThreadExportFormat = "json",
  ) {
    const session = useSessions
      .getState()
      .sessions.find((item) => item.id === sessionId);
    if (!session) return;
    const content =
      format === "markdown"
        ? sessionMarkdownExport(session)
        : JSON.stringify(sessionExportPayload(session), null, 2);
    const blob = new Blob([content], {
      type: format === "markdown" ? "text/markdown" : "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = chatExportFilename(session.title, format);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setChatNotice({
      tone: "info",
      message:
        format === "markdown"
          ? "Thread exported as Markdown."
          : "Thread exported.",
    });
  }

  function importSessionFromFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,text/markdown,.json,.md,.milim-chat.json";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      void file
        .text()
        .then((text) => {
          const isMarkdown =
            file.name.toLowerCase().endsWith(".md") ||
            file.type === "text/markdown";
          const candidate = isMarkdown
            ? markdownSessionCandidate(text)
            : exportedSessionCandidate(JSON.parse(text));
          if (!candidate)
            throw new Error("The selected file is not a Milim thread export.");
          const importedId = useSessions.getState().importSession(candidate);
          if (!importedId)
            throw new Error(
              "The selected file did not contain a usable thread.",
            );
          setChatNotice({ tone: "info", message: "Thread imported." });
        })
        .catch((error) =>
          setChatNotice({
            tone: "error",
            message: `Import failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
        );
    };
    input.click();
  }

  function forkThreadAt(messageIndex: number) {
    if (busy) return;
    const forkedId = useSessions.getState().forkSession(activeId, messageIndex);
    if (!forkedId) return;
    setEditing(null);
    setChatNotice({ tone: "info", message: "Thread branched." });
    focusComposer();
  }

  function deleteMessageAt(messageIndex: number) {
    if (busy) return;
    const latest = sessionMessages(activeId);
    if (messageIndex < 0 || messageIndex >= latest.length) return;
    setEditing(null);
    setMessages(
      activeId,
      latest.filter((_, index) => index !== messageIndex),
      { autoTitle: false },
    );
    useSessions.getState().clearAccountRuntime(activeId);
    setChatNotice({ tone: "info", message: "Message deleted." });
  }

  async function restoreWorkspaceCheckpoint(checkpoint: WorkspaceCheckpoint) {
    if (busy) return;
    if (
      !window.confirm(
        `Restore workspace files to before this turn?\n\n${checkpoint.folder}`,
      )
    )
      return;
    try {
      await setWorkspace(checkpoint.folder);
      const result = await runWorkspaceGitAction("restore_checkpoint", {
        checkpoint: checkpoint.ref,
      });
      if (!result.ok) throw new Error(result.message);
      setChatNotice({
        tone: "info",
        message: "Workspace restored to before this turn.",
      });
      openGitPanel();
    } catch (error) {
      setChatNotice({
        tone: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function editMessageInPlace(messageIndex: number, newText: string) {
    const content = newText.trim();
    setEditing(null);
    if (busy || !content) return;
    const latest = sessionMessages(activeId);
    if (!latest[messageIndex]) return;
    const next = latest.map((message, index) =>
      index === messageIndex ? { ...message, content } : message,
    );
    setMessages(activeId, next, { autoTitle: false });
    useSessions.getState().clearAccountRuntime(activeId);
    setChatNotice({ tone: "info", message: "Message updated." });
  }

  function runSlashCommand(id: string, argument: string): boolean {
    const feature = slashCommandFeature(id);
    if (feature && !featureVisibleInMode(feature, interfaceMode)) {
      setChatNotice({
        tone: "info",
        message: "Switch to Workbench mode to use that command.",
      });
      return true;
    }
    const arg = argument.trim();
    switch (id) {
      case "plan": {
        const normalized = arg.toLowerCase();
        if (!arg || normalized === "on") {
          setPlanModeActive(true);
          return true;
        }
        if (normalized === "off") {
          setPlanModeActive(false);
          return true;
        }
        if (activeMediaTarget) {
          setChatNotice({
            tone: "error",
            message: "Switch to a chat model before starting Plan Mode.",
          });
          return true;
        }
        const selectedModel = requireChatModel();
        if (!selectedModel) return true;
        updateThreadSettings(activeId, { planMode: true });
        const attachments = pendingAttachments;
        setPendingAttachments([]);
        if (busy) {
          enqueueQueuedMessage(activeId, {
            content: arg,
            attachments: attachments.length ? attachments : undefined,
          });
          setChatNotice({
            tone: "info",
            message:
              "Plan request queued. Tools will be limited to read-only inspection.",
          });
          return true;
        }
        setChatNotice(null);
        void runTurnAndDrain(
          appendUserTurn(
            messages,
            arg,
            attachments.length ? attachments : undefined,
          ),
          selectedModel,
        );
        return true;
      }
      case "goal":
        if (arg) {
          startGoalRun({
            objective: arg,
            successCriteria: "",
            constraints: "",
            developerMaxTurns: null,
          });
        } else {
          openGoalPanel(null);
        }
        return true;
      case "model": {
        if (arg) {
          updateThreadSettings(activeId, { model: arg });
          setChatNotice(null);
        } else {
          setChatNotice({
            tone: "info",
            message:
              "Choose a model from the picker, or run /model <model-id>.",
          });
        }
        return true;
      }
      case "folder": {
        if (arg) updateThreadSettings(activeId, { folder: arg });
        else void pickFolder();
        return true;
      }
      case "sandbox":
        updateThreadSettings(activeId, { sandbox: true });
        return true;
      case "nosandbox":
        updateThreadSettings(activeId, { sandbox: false });
        return true;
      case "computer":
        updateThreadSettings(activeId, { computerUse: true });
        return true;
      case "nocomputer":
        updateThreadSettings(activeId, { computerUse: false });
        return true;
      case "memory":
        updateThreadSettings(activeId, { memory: true });
        return true;
      case "nomemory":
        updateThreadSettings(activeId, { memory: false });
        return true;
      case "privacy": {
        if (arg === "off" || arg === "redact" || arg === "block") {
          updateThreadSettings(activeId, { privacy: arg });
        } else {
          updateThreadSettings(activeId, { privacy: "redact" });
        }
        return true;
      }
      case "approval": {
        if (arg === "review" || arg === "guarded" || arg === "open") {
          updateThreadSettings(activeId, { toolApproval: arg });
        } else {
          cycleToolApproval();
        }
        return true;
      }
      case "agent": {
        const target = arg.toLowerCase();
        if (
          !target ||
          target === "none" ||
          target === "off" ||
          target === "default"
        ) {
          updateThreadSettings(activeId, { activeAgentId: null });
          return true;
        }
        const agent = agents.find(
          (a) =>
            a.id.toLowerCase() === target || a.name.toLowerCase() === target,
        );
        if (agent) {
          updateThreadSettings(activeId, { activeAgentId: agent.id });
          setChatNotice(null);
        } else {
          setChatNotice({ tone: "error", message: `Agent not found: ${arg}` });
        }
        return true;
      }
      case "compact":
        void compactThreadManually();
        return true;
      case "export":
        exportSessionById(
          activeId,
          arg === "md" || arg === "markdown" ? "markdown" : "json",
        );
        return true;
      case "import":
        importSessionFromFile();
        return true;
      case "clear":
        setPendingAttachments([]);
        useSessions.getState().newChat(threadSettings);
        focusComposer();
        return true;
      default:
        return false;
    }
  }

  function updateInlineMediaAdvanced(value: string) {
    setMediaAdvanced(value);
    const target = activeMediaTarget;
    if (!target) return;
    const key = mediaPreferenceKey(target.provider.id, target.model);
    const saved = useSettings.getState().media;
    setMediaSettings({
      advancedByProviderModel: {
        ...saved.advancedByProviderModel,
        [key]: value,
      },
    });
  }

  function updateInlineMediaParameter(
    control: MediaSchemaControl,
    value: string | boolean,
  ) {
    const target = activeMediaTarget;
    if (!target) return;
    let parsed: unknown;
    try {
      parsed = parseControlValue(control, value);
    } catch (e) {
      setMediaError(e instanceof Error ? e.message : String(e));
      return;
    }
    const next = { ...mediaParameterValues, [control.key]: parsed };
    const key = mediaPreferenceKey(target.provider.id, target.model);
    const saved = useSettings.getState().media;
    setMediaParameterValues(next);
    setMediaSettings({
      parametersByProviderModel: {
        ...saved.parametersByProviderModel,
        [key]: next,
      },
    });
    setMediaError(null);
  }

  async function pollInlineMediaStatus(
    initial: MediaGenerationResult,
    sessionId: string,
    requestId: string,
  ) {
    if (!shouldPollMediaStatus(initial)) return;
    let current = initial;
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 3000));
        const next = await getMediaStatus({
          provider_id: current.provider_id,
          id: current.id,
          model: current.model,
          response_url: current.urls.response,
          status_url: current.urls.status,
        });
        current = next;
        replaceMediaResult(sessionId, requestId, next);
        if (!shouldPollMediaStatus(next) || next.media.length > 0) break;
      }
    } catch (e) {
      updateMediaMessage(sessionId, requestId, {
        content: `Media status failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  async function sendMediaPrompt(
    text: string,
    target: ActiveMediaTarget,
    baseMessages: ChatMessage[] = messages,
    checkPendingAttachments = true,
  ) {
    if (checkPendingAttachments && pendingAttachments.length > 0) {
      setChatNotice({
        tone: "error",
        message:
          "Media generation uses the prompt text only. Remove attachments or choose a chat model.",
      });
      return;
    }
    if (generationControllersRef.current.has(activeId)) return;

    let requestInput: Record<string, unknown>;
    try {
      requestInput = inputWithSchemaControls(
        mediaAdvanced,
        mediaSchema,
        mediaParameterValues,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setMediaError(message);
      setChatNotice({ tone: "error", message });
      return;
    }

    const sessionId = activeId;
    const requestId = attachmentId();
    const kind = target.supportedKinds.includes(mediaKind)
      ? mediaKind
      : target.kind;
    const prompt = mediaPromptWithHistory(baseMessages, text);
    const userMessage: ChatMessage = { role: "user", content: text };
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: `Generating ${kind} with ${target.model}...`,
      mediaRequestId: requestId,
    };
    setInput("");
    setPendingAttachments([]);
    setChatNotice(null);
    setMediaError(null);
    setMessages(sessionId, [...baseMessages, userMessage, assistantMessage], {
      autoTitle: autoTitleChats,
    });

    const store = useSessions.getState();
    const controller = new AbortController();
    generationControllersRef.current.set(sessionId, controller);
    store.setSessionGenerating(sessionId, true);
    try {
      const result = await generateMedia(
        {
          provider_id: target.provider.id,
          kind,
          model: target.model,
          prompt,
          input: requestInput,
        },
        controller.signal,
      );
      replaceMediaResult(sessionId, requestId, result);
      void pollInlineMediaStatus(result, sessionId, requestId);
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      updateMediaMessage(sessionId, requestId, {
        content: aborted
          ? "Media generation stopped."
          : `Media generation failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      generationControllersRef.current.delete(sessionId);
      store.setSessionGenerating(sessionId, false);
      store.setSessionUnread(
        sessionId,
        useSessions.getState().activeId !== sessionId,
      );
    }
  }

  async function ensureCodexAccount(): Promise<AccountRuntimeReady> {
    try {
      const account = await getCodexAccount(false);
      if (account.account || !account.requiresOpenaiAuth) return { ok: true };
    } catch (e) {
      const message = `Codex is unavailable: ${e instanceof Error ? e.message : String(e)}`;
      const warning = isCliPathWarningMessage(message);
      setChatNotice({ tone: warning ? "warning" : "error", message });
      return { ok: false, message, warning };
    }

    let completed = false;
    let failed: string | null = null;
    let warning = false;
    let opened = false;
    setChatNotice({ tone: "info", message: "Starting Codex login..." });
    try {
      await streamCodexDeviceLogin((ev: CodexLoginEvent) => {
        if (ev.type === "browser") {
          if (!opened) {
            opened = true;
            void openExternalUrl(ev.auth_url).catch((error) => {
              setChatNotice({
                tone: "error",
                message: `Could not open Codex login URL: ${error instanceof Error ? error.message : String(error)}`,
              });
            });
          }
          setChatNotice({
            tone: "info",
            message:
              "Complete Codex login in the browser. This turn will continue when login finishes.",
          });
        } else if (ev.type === "device_code") {
          if (!opened) {
            opened = true;
            void openExternalUrl(ev.verification_url).catch((error) => {
              setChatNotice({
                tone: "error",
                message: `Could not open Codex device-code URL: ${error instanceof Error ? error.message : String(error)}`,
              });
            });
          }
          setChatNotice({
            tone: "info",
            message: `Complete Codex login with code ${ev.user_code}. This turn will continue when login finishes.`,
          });
        } else if (ev.type === "done") {
          completed = ev.success;
          failed = ev.error ?? null;
        } else if (ev.type === "warning") {
          failed = ev.message;
          warning = true;
          setChatNotice({ tone: "warning", message: ev.message });
        } else if (ev.type === "error") {
          failed = ev.message;
        }
      });
    } catch (e) {
      const message = `Codex login failed: ${e instanceof Error ? e.message : String(e)}`;
      warning = isCliPathWarningMessage(message);
      setChatNotice({ tone: warning ? "warning" : "error", message });
      return { ok: false, message, warning };
    }
    if (completed) {
      setChatNotice({ tone: "info", message: "Codex login completed." });
      return { ok: true };
    }
    const message = failed || "Codex login did not complete.";
    warning ||= isCliPathWarningMessage(message);
    setChatNotice({ tone: warning ? "warning" : "error", message });
    return { ok: false, message, warning };
  }

  async function ensureClaudeAccount(): Promise<AccountRuntimeReady> {
    try {
      const status = await getClaudeStatus();
      if (status.available && status.authenticated) return { ok: true };
      const message = status.available
        ? "Claude Code is not signed in. Run `claude auth login` in a terminal, then refresh models."
        : `Claude Code is unavailable: ${status.error || "install Claude Code and make sure `claude` is on PATH."}`;
      const warning =
        Boolean(status.warning) || isCliPathWarningMessage(message);
      setChatNotice({
        tone: warning ? "warning" : "error",
        message,
      });
      return { ok: false, message, warning };
    } catch (e) {
      const message = `Claude Code is unavailable: ${e instanceof Error ? e.message : String(e)}`;
      const warning = isCliPathWarningMessage(message);
      setChatNotice({ tone: warning ? "warning" : "error", message });
      return { ok: false, message, warning };
    }
  }

  /** Stream the assistant's reply to a conversation that ends with a user turn. */
  async function runTurn(
    convo: ChatMessage[],
    selectedModel?: string,
    options: RunTurnOptions = {},
    sessionId = activeId,
  ): Promise<RunTurnResult> {
    const id = sessionId;
    if (generationControllersRef.current.has(id)) {
      return {
        status: "skipped",
        messages: sessionMessages(id, convo),
        error: "A turn is already running.",
      };
    }
    const turnSetup = resolveTurnSetup({
      sessionId: id,
      selectedModel,
      sessions: useSessions.getState().sessions,
      settings: useSessions.getState().getSettings(id),
      agents: useAgents.getState().agents,
      activeTitle,
      requireModel: requireChatModel,
      codexRuntimeModel,
      claudeRuntimeModel,
      isCodexModel,
      isClaudeModel,
    });
    if (!turnSetup.ok) {
      setChatNotice({ tone: "error", message: turnSetup.error });
      return {
        status: "error",
        messages: sessionMessages(id, convo),
        error: turnSetup.error,
      };
    }
    const turnSettings = turnSetup.settings;
    const turnActiveAgent = turnSetup.activeAgent;
    const turnModel = turnSetup.model;
    const turnInstructions = turnSettings.instructions;
    const turnFolder = turnSettings.folder;
    const turnSandbox = turnSettings.sandbox;
    const turnComputerUse = turnSettings.computerUse;
    const turnMemory = turnSettings.memory;
    const turnActiveAgentId = turnSettings.activeAgentId ?? null;
    const turnToolApproval = turnSettings.toolApproval;
    const turnPlanMode = turnSettings.planMode;
    const turnReasoningEffort = reasoningEffortForModel(
      useSettings.getState().reasoningEffortByModel,
      turnModel,
      pickerModels,
    );
    const turnTitle = turnSetup.title;
    const codexModel = turnSetup.codexModel;
    const claudeModel = turnSetup.claudeModel;
    const store = useSessions.getState();
    const controller = claimTurnGeneration({
      sessionId: id,
      store,
      generationControllersRef,
    });
    if (!controller) {
      return {
        status: "skipped",
        messages: sessionMessages(id, convo),
        error: "A turn is already running.",
      };
    }
    let notReady: Awaited<ReturnType<typeof accountRuntimeNotReadyForTurn>>;
    try {
      notReady = await accountRuntimeNotReadyForTurn({
        codexModel,
        claudeModel,
        conversation: convo,
        ensureCodexAccount,
        ensureClaudeAccount,
      });
    } catch (e) {
      releaseTurnGeneration({
        sessionId: id,
        store,
        generationControllersRef,
      });
      throw e;
    }
    if (notReady) {
      releaseTurnGeneration({
        sessionId: id,
        store,
        generationControllersRef,
      });
      setMessages(id, notReady.messages, { autoTitle: autoTitleChats });
      return {
        status: notReady.status,
        messages: sessionMessages(id, convo),
        error: notReady.error,
      };
    }
    const startedAt = Date.now();
    let resultStatus: RunTurnResult["status"] = "done";
    let resultError: string | undefined;
    const turnId = attachmentId();
    const assistantMessageId = createChatMessageId();
    setChatNotice(null);

    const { streamBatcher, append, appendThinking } = startTurnStream({
      sessionId: id,
      messageId: assistantMessageId,
      store,
      controller,
    });
    const assistantStart = createTurnAssistantStarter({
      conversation: convo,
      planMode: turnPlanMode,
      setMessages: (nextMessages) =>
        setMessages(id, nextMessages, { autoTitle: autoTitleChats }),
      assistantMessageId,
    });
    const beginAssistant = assistantStart.beginAssistant;
    const metricsCapture = createTurnMetricsCapture();
    let promptContext: Awaited<ReturnType<typeof prepareTurnPromptContext>>;
    try {
      promptContext = await prepareTurnPromptContext({
        sessionId: id,
        threadTitle: turnTitle,
        folder: turnFolder,
        instructions: turnInstructions,
        planMode: turnPlanMode,
        memory: turnMemory,
        conversation: convo,
        activeAgent: turnActiveAgent ?? null,
        skills,
        goal: options.goal,
        turnId,
        codexModel,
        claudeModel,
        model: turnModel,
        sandbox: turnSandbox,
        computerUse: turnComputerUse,
        previewTools: Boolean(
          sidePanelOpen && sidePanelMode !== "git" && visiblePreviewSelection,
        ),
        activeAgentId: turnActiveAgentId,
        toolApproval: turnToolApproval,
        toolApprovalGrant: false,
        experimentalHashlinePatch,
        messageContent: wireMessageContent,
        searchMemory: searchGraphMemory,
        selectSkills,
        virtualProjectFiles: turnFolder.trim()
          ? []
          : sessionVirtualProjectFiles(
              store.sessions.find((session) => session.id === id),
            ),
      });
    } catch (e) {
      releaseTurnGeneration({
        sessionId: id,
        store,
        generationControllersRef,
      });
      throw e;
    }
    const { useTools, accountRuntimeMayUseTools, runMemoryContext } =
      promptContext;
    const toolApprovalDecision = resolveTurnToolApproval({
      useTools,
      accountRuntimeMayUseTools,
      toolApproval: turnToolApproval,
      planMode: turnPlanMode,
      requestedGrant: options.toolApprovalGrant,
    });
    if (
      toolApprovalDecision.status === "denied" ||
      toolApprovalDecision.status === "required"
    ) {
      generationControllersRef.current.delete(id);
      store.setSessionGenerating(id, false);
      if (toolApprovalDecision.status === "denied") {
        setMessages(id, convo, { autoTitle: autoTitleChats });
        setChatNotice({ tone: "info", message: "Tool run canceled." });
        return {
          status: "skipped",
          messages: sessionMessages(id, convo),
          error: toolApprovalDecision.error,
        };
      }
      requestToolApprovalCard(id, convo, turnModel, "reply");
      return {
        status: "skipped",
        messages: sessionMessages(id, convo),
        error: toolApprovalDecision.error,
      };
    }
    const toolApprovalGrant = toolApprovalDecision.grant;
    const toolContext = {
      ...promptContext.toolContext,
      tool_approval_grant: toolApprovalGrant,
    };
    const createWorkspaceCheckpoint = () =>
      checkpointWorkspaceBeforeTurn({
        sessionId: id,
        turnId,
        folder: turnFolder,
        planMode: turnPlanMode,
        useTools,
        accountRuntimeMayUseTools,
        setWorkspace,
        runWorkspaceGitAction,
        attachCheckpoint: attachAssistantWorkspaceCheckpoint,
        appendStreamEvent: (targetId, part) =>
          store.appendStreamEvent(targetId, assistantMessageId, part),
      });

    const { runRef, snapshot } = createTurnRunTraceState((run) =>
      store.commitRun(id, assistantMessageId, run),
    );
    const captureAgentUsageDelta = (usage?: TokenUsage) => {
      const totalUsage = metricsCapture.captureUsageDelta(usage);
      if (!totalUsage || !assistantStart.state.started) return;
      commitResponseMetrics(
        id,
        assistantMessageId,
        responseMetricsForTurn({
          startedAt,
          endedAt: Date.now(),
          model: turnModel,
          providers,
          codexModel,
          claudeModel,
          usage: totalUsage,
          limits: metricsCapture.state.limits,
        }),
      );
    };
    const onEvent = createAgentRunEventHandler({
      runRef,
      append,
      appendThinking,
      flush: () => streamBatcher.flush(),
      appendStreamEvent: (part) =>
        store.appendStreamEvent(id, assistantMessageId, part),
      completeStreamEvent: (name, part, callId) =>
        store.completeStreamEvent(id, assistantMessageId, name, part, callId),
      appendMemoryNotice: (notice) =>
        store.appendMemoryNotice(id, assistantMessageId, notice),
      upsertChildThread: (thread) => store.upsertChildThread(id, thread),
      updateChildThread: (thread) => store.updateChildThread(thread),
      captureUsage: metricsCapture.captureUsage,
      captureUsageDelta: captureAgentUsageDelta,
      snapshot,
    });
    const prepareOutbound = (
      contextMessages: ChatMessage[],
      conversation: ChatMessage[],
      options?: PrepareTurnOutboundOptions,
    ) =>
      prepareTurnOutbound({
        sessionId: id,
        contextMessages,
        conversation,
        model: turnModel,
        models: pickerModels,
        folder: turnFolder,
        reasoningEffort: turnReasoningEffort,
        compactionInFlightRef,
        setChatNotice,
        createCompactionCheckpoint,
        clearAccountRuntime: (targetId) => store.clearAccountRuntime(targetId),
        skipAutoCompaction: options?.skipAutoCompaction,
        signal: options?.signal,
      });

    try {
      if (codexModel || claudeModel) {
        const accountRuntime = useSessions
          .getState()
          .sessions.find((session) => session.id === id)?.accountRuntime;
        const accountResult = await runSelectedAccountRuntimeTurn({
          codexModel,
          claudeModel,
          accountRuntime,
          promptContext,
          conversation: assistantStart.state.activeConversation,
          prepareOutbound,
          beginAssistant,
          checkpointWorkspace: createWorkspaceCheckpoint,
          workspace: turnFolder.trim() || undefined,
          reasoningEffort: turnReasoningEffort,
          toolApproval: turnToolApproval,
          toolApprovalGrant,
          planMode: turnPlanMode,
          append,
          appendThinking,
          flush: () => streamBatcher.flush(),
          appendStreamEvent: (part) =>
            store.appendStreamEvent(id, assistantMessageId, part),
          completeStreamEvent: (name, part) =>
            store.completeStreamEvent(id, assistantMessageId, name, part),
          captureRuntimeMetrics: metricsCapture.captureRuntimeMetrics,
          captureProviderLimit: metricsCapture.captureProviderLimit,
          setCodexThreadId: (threadId) =>
            store.setAccountRuntime(id, { codexThreadId: threadId }),
          appendImage: (ev) => {
            appendAssistantMediaResult(
              id,
              codexImageMediaResult(ev, codexModel ?? ""),
            );
            store.appendStreamEvent(
              id,
              assistantMessageId,
              statusPart(
                "Generated image",
                ev.revised_prompt ? compactText(ev.revised_prompt) : undefined,
              ),
            );
          },
          ensureClaudeSessionId: () =>
            useSessions.getState().ensureClaudeSessionId(id),
          streamCodexRun,
          streamClaudeRun,
          signal: controller.signal,
        });
        if (accountResult?.status === "skipped") {
          resultStatus = "skipped";
          resultError = accountResult.error;
        }
      } else if (useTools) {
        startChildThreadEvents(id);
        const agentResult = await runToolAgentTurn({
          promptContext,
          conversation: assistantStart.state.activeConversation,
          prepareOutbound,
          beginAssistant,
          checkpointWorkspace: createWorkspaceCheckpoint,
          streamAgentRun,
          agentId: turnActiveAgentId,
          model: turnModel,
          onEvent,
          signal: controller.signal,
          runMemoryContext,
          toolContext,
          reasoningEffort: turnReasoningEffort,
          runRef,
          snapshot,
          workspace: turnFolder.trim() || undefined,
          sourceSessionId: APP_SESSION_ID,
        });
        if (agentResult.status === "error") {
          resultStatus = "error";
          resultError = agentResult.error || "Agent run failed.";
        }
      } else {
        await runModelChatTurn({
          promptContext,
          conversation: assistantStart.state.activeConversation,
          prepareOutbound,
          beginAssistant,
          streamChat,
          model: turnModel,
          append,
          signal: controller.signal,
          appendThinking,
          captureUsage: metricsCapture.captureUsage,
          reasoningEffort: turnReasoningEffort,
        });
      }
      streamBatcher.flush();
    } catch (e) {
      const errorResult = handleTurnRuntimeError({
        error: e,
        assistantStarted: assistantStart.state.started,
        append,
        flush: () => streamBatcher.flush(),
        setChatNotice,
        appendStreamEvent: (part) =>
          store.appendStreamEvent(id, assistantMessageId, part),
        runRef,
        snapshot,
        signal: controller.signal,
      });
      resultStatus = errorResult.status;
      resultError = errorResult.error;
    } finally {
      const endedAt = Date.now();
      finalizeTurnRuntime({
        sessionId: id,
        model: turnModel,
        status: resultStatus,
        flush: () => streamBatcher.flush(),
        metrics: assistantStart.state.started
          ? responseMetricsForTurn({
              startedAt,
              endedAt,
              model: turnModel,
              providers,
              codexModel,
              claudeModel,
              usage: metricsCapture.state.usage,
              costUsd: metricsCapture.state.costUsd,
              limits: metricsCapture.state.limits,
            })
          : undefined,
        commitResponseMetrics: (targetId, metrics) =>
          commitResponseMetrics(targetId, assistantMessageId, metrics),
        clearController: (targetId) =>
          generationControllersRef.current.delete(targetId),
        setSessionGenerating: store.setSessionGenerating,
        setSessionUnread: store.setSessionUnread,
        activeSessionId: useSessions.getState().activeId,
        stopChildThreadEventsIfIdle,
        maybeGenerateAiThreadTitle,
        flushUserState: () => flushDeferredUserStateWrites("milim.sessions"),
        signal: controller.signal,
      });
    }
    return {
      status: resultStatus,
      messages: sessionMessages(id, assistantStart.state.activeConversation),
      error: resultError,
    };
  }

  function send() {
    const text = input.trim();
    if (!text && pendingAttachments.length === 0) return;
    if (compactionInFlightRef.current) {
      setChatNotice({
        tone: "info",
        message: "Wait for context compaction to finish before sending.",
      });
      return;
    }
    if (busy) {
      if (activeMediaTarget) {
        setChatNotice({
          tone: "error",
          message:
            "Wait for media generation to finish before sending another media prompt.",
        });
        return;
      }
      enqueueQueuedMessage(activeId, {
        content: text,
        attachments: pendingAttachments,
      });
      setInput("");
      setPendingAttachments([]);
      setChatNotice({
        tone: "info",
        message:
          "Message queued. It will run after the current reply finishes.",
      });
      return;
    }
    if (activeMediaTarget) {
      if (!text) {
        setChatNotice({
          tone: "error",
          message: "Describe the media to generate before sending.",
        });
        return;
      }
      void sendMediaPrompt(text, activeMediaTarget);
      return;
    }
    const selectedModel = requireChatModel();
    if (!selectedModel) return;
    const attachments = pendingAttachments;
    setInput("");
    setPendingAttachments([]);
    void runTurnAndDrain(
      appendUserTurn(messages, text, attachments),
      selectedModel,
    );
  }

  function sendArtifactFixPrompt(prompt: string) {
    const text = prompt.trim();
    if (!text) return;
    if (busy && !activeMediaTarget) {
      enqueueQueuedMessage(activeId, { content: text });
      setChatNotice({ tone: "info", message: "Artifact fix prompt queued." });
      return;
    }
    if (busy || activeMediaTarget) {
      setInput((current) =>
        current.trimEnd() ? `${current.trimEnd()}\n${text}` : text,
      );
      setChatNotice({
        tone: "info",
        message: "Artifact fix prompt is waiting in the composer.",
      });
      return;
    }
    const selectedModel = effectiveModel.trim();
    if (!selectedModel) {
      setInput((current) =>
        current.trimEnd() ? `${current.trimEnd()}\n${text}` : text,
      );
      setProvidersOpen(true);
      setChatNotice({
        tone: "error",
        message:
          "Artifact fix prompt is waiting in the composer. Choose a model before sending.",
      });
      return;
    }
    setInput("");
    setPendingAttachments([]);
    void runTurnAndDrain(appendUserTurn(messages, text), selectedModel);
  }

  function executePlan(messageIndex: number, planMessage: ChatMessage) {
    if (busy || activeMediaTarget) return;
    const planText = wireMessageContent(planMessage).trim();
    if (!planText) return;
    const selectedModel = requireChatModel();
    if (!selectedModel) return;
    const now = Date.now();
    const baseMessages = messages.map((message, index) =>
      index === messageIndex
        ? { ...message, plan: { status: "executed" as const, executedAt: now } }
        : message,
    );
    updateThreadSettings(activeId, { planMode: false });
    setChatNotice({ tone: "info", message: "Plan approved. Executing..." });
    void runTurnAndDrain(
      appendUserTurn(baseMessages, executePlanPrompt(planText)),
      selectedModel,
    );
  }

  /** Re-run the last user turn (drop trailing assistant message(s)). */
  function regenerate() {
    if (busy) return;
    const convo = regenerateTurnConversation(messages);
    if (!convo) return;
    const last = convo[convo.length - 1];
    if (activeMediaTarget && last?.role === "user" && last.content.trim()) {
      void sendMediaPrompt(
        last.content.trim(),
        activeMediaTarget,
        convo.slice(0, -1),
        false,
      );
      return;
    }
    void runTurnAndDrain(convo);
  }

  /** Replace the user message at `index`, drop everything after it, re-run. */
  function editResend(index: number, newText: string) {
    setEditing(null);
    const text = newText.trim();
    if (busy || !text) return;
    if (activeMediaTarget) {
      void sendMediaPrompt(
        text,
        activeMediaTarget,
        messages.slice(0, index),
        false,
      );
      return;
    }
    const convo = editResendConversation(messages, index, text);
    if (!convo) return;
    void runTurnAndDrain(convo);
  }

  function stop() {
    const session = useSessions
      .getState()
      .sessions.find((item) => item.id === activeId);
    if (
      session?.worker?.status === "queued" ||
      session?.worker?.status === "running"
    ) {
      void stopChildThread(activeId)
        .then((thread) => useSessions.getState().updateChildThread(thread))
        .catch((error) =>
          setChatNotice({
            tone: "error",
            message: `Worker stop failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
        );
      return;
    }
    generationControllersRef.current.get(activeId)?.abort();
  }

  function focusComposer() {
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')
        ?.focus();
    });
  }

  function openChatSearch() {
    setChatSearchOpen(true);
  }

  function switchToPreviousThread() {
    const previousId = previousThreadIdRef.current;
    if (!previousId || previousId === activeId) return;
    if (
      sessionSummaries.some(
        (session) => session.id === previousId && !session.archivedAt,
      )
    ) {
      switchToSession(previousId);
    } else {
      previousThreadIdRef.current = null;
    }
  }

  function startShortcutNewChat() {
    setInput("");
    setPendingAttachments([]);
    setChatNotice(null);
    useSessions.getState().newChat(threadSettings);
    focusComposer();
  }

  function stopFromShortcut() {
    if (!busy) return;
    const now = Date.now();
    if (now <= stopShortcutConfirmUntilRef.current) {
      stopShortcutConfirmUntilRef.current = 0;
      if (stopShortcutConfirmTimerRef.current != null) {
        window.clearTimeout(stopShortcutConfirmTimerRef.current);
        stopShortcutConfirmTimerRef.current = null;
      }
      stop();
      return;
    }

    const message = `Press ${shortcutLabel(appShortcuts.stopGeneration)} again to stop generation.`;
    stopShortcutConfirmUntilRef.current = now + 2000;
    setChatNotice({ tone: "info", message });
    if (stopShortcutConfirmTimerRef.current != null)
      window.clearTimeout(stopShortcutConfirmTimerRef.current);
    stopShortcutConfirmTimerRef.current = window.setTimeout(() => {
      stopShortcutConfirmUntilRef.current = 0;
      setChatNotice((notice) => (notice?.message === message ? null : notice));
      stopShortcutConfirmTimerRef.current = null;
    }, 2000);
  }

  function shortcutTargetBlocked(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return Boolean(
      target.closest('[role="dialog"], [data-shortcut-recorder="true"]'),
    );
  }

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || shortcutTargetBlocked(event.target)) return;
      if (shortcutMatchesEvent(appShortcuts.newChat, event)) {
        event.preventDefault();
        startShortcutNewChat();
      } else if (shortcutMatchesEvent(appShortcuts.focusSearch, event)) {
        event.preventDefault();
        openChatSearch();
      } else if (shortcutMatchesEvent(appShortcuts.focusComposer, event)) {
        event.preventDefault();
        focusComposer();
      } else if (shortcutMatchesEvent(appShortcuts.toggleSidebar, event)) {
        event.preventDefault();
        toggleSidebar();
      } else if (shortcutMatchesEvent(appShortcuts.previousThread, event)) {
        event.preventDefault();
        switchToPreviousThread();
      } else if (shortcutMatchesEvent(appShortcuts.stopGeneration, event)) {
        event.preventDefault();
        stopFromShortcut();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [
    activeId,
    appShortcuts,
    busy,
    sessionSummaries,
    switchToSession,
    threadSettings,
    toggleSidebar,
  ]);

  function mobileRelayAttachments(
    attachments?: MobileRelayAttachment[],
  ): ChatAttachment[] {
    return (attachments ?? [])
      .filter(
        (attachment) =>
          attachment.name && attachment.mime && attachment.size >= 0,
      )
      .map((attachment) => ({
        id: attachment.id || attachmentId(),
        name: attachment.name,
        mime: attachment.mime,
        size: attachment.size,
        content: attachment.content,
        dataUrl: attachment.dataUrl,
        truncated: Boolean(attachment.truncated),
      }));
  }

  function appendMobileRelayText(
    text: string,
    attachments: ChatAttachment[] = [],
  ) {
    if (text) {
      setInput((current) => {
        const trimmed = current.trimEnd();
        return trimmed ? `${trimmed}\n${text}` : text;
      });
    }
    if (attachments.length) {
      setPendingAttachments((current) =>
        [...current, ...attachments].slice(0, 12),
      );
    }
  }

  function sendMobileRelayText(event: MobileRelayEvent) {
    const text = event.text.trim();
    const attachments = mobileRelayAttachments(event.attachments);
    if (!text && attachments.length === 0) return;
    if (busy) {
      enqueueQueuedMessage(activeId, { content: text, attachments });
      setChatNotice({
        tone: "info",
        message: `Mobile relay from ${event.device_name} queued.`,
      });
      return;
    }
    const selectedModel = effectiveModel.trim();
    if (!selectedModel) {
      appendMobileRelayText(text, attachments);
      setProvidersOpen(true);
      setChatNotice({
        tone: "error",
        message:
          "Mobile relay is waiting in the composer. Choose a model before sending.",
      });
      return;
    }
    setInput("");
    setPendingAttachments([]);
    setChatNotice({
      tone: "info",
      message: `Mobile relay from ${event.device_name} sent.`,
    });
    void runTurnAndDrain(
      appendUserTurn(
        messages,
        text,
        attachments.length ? attachments : undefined,
      ),
      selectedModel,
    );
  }

  function runQueuedMessages() {
    if (busy) return;
    if (activeMediaTarget) {
      setChatNotice({
        tone: "error",
        message: "Choose a chat model before running queued messages.",
      });
      return;
    }
    const selectedModel = requireChatModel();
    if (!selectedModel) return;
    void drainQueuedMessages(activeId, selectedModel);
  }

  function editQueuedMessage(item: QueuedMessage) {
    if (input.trim() || pendingAttachments.length > 0) {
      setChatNotice({
        tone: "info",
        message: "Clear the composer before editing a queued message.",
      });
      return;
    }
    removeQueuedMessage(activeId, item.id);
    setInput(item.content);
    setPendingAttachments(item.attachments ?? []);
    setChatNotice({
      tone: "info",
      message: "Queued message moved back to composer.",
    });
    window.requestAnimationFrame(() => {
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')
        ?.focus();
    });
  }

  function startMobileThread(event: MobileRelayEvent) {
    const text = event.text.trim();
    const attachments = mobileRelayAttachments(event.attachments);
    useSessions.getState().newChat(threadSettings);
    const sessionId = useSessions.getState().activeId;
    setInput("");
    setPendingAttachments([]);
    if (!text && attachments.length === 0) {
      setChatNotice({
        tone: "info",
        message: `Mobile relay from ${event.device_name} created a thread.`,
      });
      return;
    }
    const selectedModel = queuedModelForSession(
      sessionId,
      effectiveModel.trim(),
      agents,
    );
    if (!selectedModel) {
      enqueueQueuedMessage(sessionId, { content: text, attachments });
      setProvidersOpen(true);
      setChatNotice({
        tone: "error",
        message:
          "Mobile relay created a thread, but a model is needed before sending.",
      });
      return;
    }
    setChatNotice({
      tone: "info",
      message: `Mobile relay from ${event.device_name} started a thread.`,
    });
    void runTurn(
      appendUserTurn([], text, attachments.length ? attachments : undefined),
      selectedModel,
      {},
      sessionId,
    ).then((result) => {
      if (result.status === "done")
        void drainQueuedMessages(sessionId, selectedModel);
    });
  }

  function activeOrPayloadThreadId(text: string): string {
    return text.trim() || activeId;
  }

  function deleteMobileMessage(text: string) {
    const index = Number.parseInt(text.trim(), 10);
    if (!Number.isFinite(index)) return;
    deleteMessageAt(index);
  }

  function applyMobileRelayEvent(event: MobileRelayEvent) {
    if (event.action === "new_thread") {
      startMobileThread(event);
      return;
    }
    if (event.action === "stop") {
      stop();
      setChatNotice({
        tone: "info",
        message: `Mobile relay from ${event.device_name} stopped generation.`,
      });
      return;
    }
    if (event.action === "regenerate") {
      regenerate();
      return;
    }
    if (event.action === "delete_message") {
      deleteMobileMessage(event.text);
      return;
    }
    if (event.action === "rename_thread") {
      const title = event.text.trim();
      if (title) useSessions.getState().rename(activeId, title);
      return;
    }
    if (event.action === "archive_thread") {
      useSessions
        .getState()
        .archiveSession(activeOrPayloadThreadId(event.text));
      return;
    }
    if (event.action === "delete_thread") {
      useSessions.getState().remove(activeOrPayloadThreadId(event.text));
      return;
    }
    if (event.action === "set_model") {
      const nextModel = event.text.trim();
      if (nextModel) updateThreadSettings(activeId, { model: nextModel });
      return;
    }
    if (event.action === "attach") {
      appendMobileRelayText(
        event.text.trim(),
        mobileRelayAttachments(event.attachments),
      );
      setChatNotice({
        tone: "info",
        message: `Mobile relay from ${event.device_name} added attachments.`,
      });
      return;
    }
    if (event.action === "switch_thread") {
      const targetId = event.text.trim();
      const target = useSessions
        .getState()
        .sessions.find(
          (session) => session.id === targetId && !session.archivedAt,
        );
      if (target) {
        switchToSession(target.id);
        setChatNotice({
          tone: "info",
          message: `Mobile relay switched to ${target.title || "thread"}.`,
        });
      }
      return;
    }
    if (event.action === "replace") {
      setInput(event.text);
      const attachments = mobileRelayAttachments(event.attachments);
      setPendingAttachments(attachments);
      setChatNotice({
        tone: "info",
        message: `Mobile relay from ${event.device_name} replaced the composer.`,
      });
      return;
    }
    if (event.action === "send") {
      sendMobileRelayText(event);
      return;
    }
    appendMobileRelayText(
      event.text,
      mobileRelayAttachments(event.attachments),
    );
    setChatNotice({
      tone: "info",
      message: `Mobile relay from ${event.device_name} added to the composer.`,
    });
  }

  function applyScheduleRunEvent(event: ScheduleRunEvent) {
    const title = `Schedule: ${event.schedule_name || event.schedule_id}`;
    const importedId = useSessions.getState().importSession({
      title,
      messages: [
        { role: "user", content: event.prompt },
        { role: "assistant", content: event.response || "(No response.)" },
      ],
      settings: { model: event.model },
    });
    if (importedId)
      setChatNotice({ tone: "info", message: `${title} completed.` });
  }

  useEffect(() => {
    let cancelled = false;
    async function pollMobileRelay() {
      if (mobileRelayPollingRef.current) return;
      mobileRelayPollingRef.current = true;
      try {
        const events = await pollMobileCompanionEvents();
        if (!cancelled) {
          for (const event of events) applyMobileRelayEvent(event);
        }
      } catch {
        // The bridge is disabled in normal web previews and before pairing.
      } finally {
        mobileRelayPollingRef.current = false;
      }
    }
    void pollMobileRelay();
    const timer = window.setInterval(() => void pollMobileRelay(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeId, busy, effectiveModel, messages, switchToSession]);

  useEffect(() => {
    let cancelled = false;
    async function pollScheduleRuns() {
      if (scheduleRunPollingRef.current) return;
      scheduleRunPollingRef.current = true;
      try {
        const events = await pollScheduleRunEvents();
        if (!cancelled) {
          for (const event of events) applyScheduleRunEvent(event);
        }
      } finally {
        scheduleRunPollingRef.current = false;
      }
    }
    void pollScheduleRuns();
    const timer = window.setInterval(() => void pollScheduleRuns(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void publishMobileThreadSnapshot({
        session_id: activeId,
        title: activeTitle,
        model: effectiveModel.trim() || null,
        busy,
        messages: mobileThreadMessages(messages),
        threads: mobileThreadSummaries(
          sessionSummaries,
          projects,
          generatingSessionIds,
        ),
        groups: mobileThreadGroups(
          sessionSummaries,
          projects,
          sidebarState,
          generatingSessionIds,
        ),
        models: mobileModelSummaries(pickerModels),
        theme: {
          is_dark: activeTheme.isDark,
          css_vars: themeCssVariables(activeTheme),
          background_fit: backgroundFit,
          background_treatment: backgroundTreatment,
        },
      }).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    activeId,
    activeTheme,
    activeTitle,
    backgroundFit,
    backgroundTreatment,
    busy,
    effectiveModel,
    generatingSessionIds,
    messages,
    pickerModels,
    projects,
    sessionSummaries,
    sidebarState,
  ]);

  const emptyThread = messages.length === 0;
  const activeRun = busy
    ? (messages
        .slice()
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" && message.run?.status === "running",
        )?.run ?? null)
    : null;
  const activeStreamParts = busy
    ? messages
        .slice()
        .reverse()
        .find(
          (message) =>
            message.role === "assistant" && message.streamParts?.length,
        )?.streamParts
    : undefined;
  const debugPreviewControlActivity =
    typeof window === "undefined"
      ? null
      : previewControlActivityFromDebugUrl(window.location.href);
  const streamPreviewControlActivity =
    previewControlActivityFromStreamParts(activeStreamParts);
  const streamPreviewControlActivityId =
    streamPreviewControlActivity?.id ?? null;
  const [recentPreviewControlActivity, setRecentPreviewControlActivity] =
    useState<ReturnType<typeof previewControlActivityFromStreamParts>>(null);
  useEffect(() => {
    if (!streamPreviewControlActivity) return;
    setRecentPreviewControlActivity(streamPreviewControlActivity);
    const timer = window.setTimeout(
      () => setRecentPreviewControlActivity(null),
      1900,
    );
    return () => window.clearTimeout(timer);
  }, [streamPreviewControlActivityId]);
  const previewControlActivity =
    debugPreviewControlActivity ??
    streamPreviewControlActivity ??
    recentPreviewControlActivity;
  const canOpenArtifactPanel = Boolean(
    latestPreviewSelection ||
    (sidePanelMode === "artifact" && previewSelection),
  );
  const sidePanelModeSwitcher = (
    <div
      className="side-panel-switcher"
      role="tablist"
      aria-label="Side panel mode"
    >
      {canOpenArtifactPanel && (
        <button
          type="button"
          className={sidePanelMode === "artifact" ? "active" : ""}
          role="tab"
          aria-selected={sidePanelMode === "artifact"}
          aria-label="Artifact panel"
          title="Artifact"
          onClick={openArtifactSidePanel}
        >
          <Code size={14} />
        </button>
      )}
      <button
        type="button"
        className={sidePanelMode === "browser" ? "active" : ""}
        role="tab"
        aria-selected={sidePanelMode === "browser"}
        aria-label="Browser panel"
        title="Browser"
        onClick={openArtifactBrowser}
      >
        <Globe size={14} />
      </button>
      {canShowGitPanel && (
        <button
          type="button"
          className={sidePanelMode === "git" ? "active" : ""}
          role="tab"
          aria-selected={sidePanelMode === "git"}
          aria-label="Git panel"
          title="Git"
          onClick={openGitPanel}
        >
          <GitBranch size={14} />
        </button>
      )}
    </div>
  );

  return (
    <div
      className={"chat" + (emptyThread ? " chat-empty" : "")}
      data-testid="chat-shell"
    >
      <div className="chat-body">
        <div className="chat-main">
          {!sidePanelVisible && (
            <button
              className="icon-btn preview-open-btn"
              data-testid="open-artifact-browser"
              title="Open side panel"
              aria-label="Open side panel"
              onClick={openSelectedSidePanel}
            >
              <PanelIcon size={16} />
            </button>
          )}
          <div
            className="chat-scroll"
            ref={chatScrollRef}
            onScroll={updateAutoScrollCoupling}
          >
            {!emptyThread && (
              <div className="messages">
                {messages.map((m, i) => {
                  markPerfRender("MessageRow");
                  const messageIsCompaction = isCompactionCheckpoint(m);
                  const isApprovalMessage = Boolean(m.approval);
                  const isLastAssistant =
                    m.role === "assistant" &&
                    !messageIsCompaction &&
                    !isApprovalMessage &&
                    i === messages.length - 1;
                  const assistantStreaming = busy && isLastAssistant;
                  const previewArtifacts = previewArtifactsForMessage(m);
                  const artifactContext = m.artifacts?.length
                    ? m.artifacts
                    : previewArtifacts;
                  const openMessagePreview = (
                    artifact: ChatArtifact,
                    revision?: ArtifactRevision,
                  ) => {
                    if (
                      !folder.trim() &&
                      !assistantStreaming &&
                      hasPreviewPackageJson(
                        previewRuntimeFiles(artifactContext),
                      )
                    ) {
                      void startPreviewRuntimeForArtifacts(artifactContext);
                      return;
                    }
                    const artifactIndex =
                      m.artifacts?.findIndex(
                        (item) => item.id === artifact.id,
                      ) ?? -1;
                    const choice =
                      !revision && artifactIndex >= 0
                        ? artifactRevisionChoice(i, artifactIndex)
                        : undefined;
                    if (!isPreviewableArtifact(artifact))
                      setArtifactPanelTab(activeId, "code");
                    openPreviewArtifact(
                      artifact,
                      artifactContext ?? [artifact],
                      assistantStreaming,
                      revision ?? choice?.revision,
                    );
                  };
                  const previewArtifactsStreaming =
                    assistantStreaming && Boolean(previewArtifacts?.length);
                  const hasStreamTranscript = Boolean(m.streamParts?.length);
                  const hasAssistantOutput = Boolean(
                    m.content || hasStreamTranscript,
                  );
                  const metricsLabel = formatResponseMetrics(m.metrics);
                  const canExecutePlan =
                    m.role === "assistant" &&
                    m.plan?.status === "proposed" &&
                    !assistantStreaming &&
                    Boolean(m.content.trim());
                  const runtimeFiles =
                    !folder.trim() && !assistantStreaming
                      ? previewRuntimeFiles(m.artifacts)
                      : [];
                  const canStartRuntime =
                    runtimeFiles.length > 0 &&
                    hasPreviewPackageJson(runtimeFiles);
                  const openMessageContextMenu = (
                    event: MouseEvent<HTMLDivElement>,
                  ) => {
                    openContextMenu(
                      event,
                      [
                        ...(canExecutePlan
                          ? [
                              {
                                id: "execute-plan",
                                label: "Execute plan",
                                icon: <ArrowRight size={13} />,
                                action: () => executePlan(i, m),
                              },
                            ]
                          : []),
                        ...(m.role === "assistant" &&
                        !messageIsCompaction &&
                        m.content &&
                        ttsReady
                          ? [
                              {
                                id: "speak",
                                label: "Speak",
                                icon: <Volume2 size={13} />,
                                action: () => void speakMessage(i, m.content),
                              },
                            ]
                          : []),
                        ...(m.workspaceCheckpoint
                          ? [
                              {
                                id: "restore-checkpoint",
                                label: "Restore workspace checkpoint",
                                icon: <Refresh size={13} />,
                                disabled: busy,
                                action: () =>
                                  void restoreWorkspaceCheckpoint(
                                    m.workspaceCheckpoint!,
                                  ),
                              },
                            ]
                          : []),
                        ...(!messageIsCompaction
                          ? [
                              {
                                id: "branch",
                                label: "Branch from here",
                                icon: <GitBranch size={13} />,
                                disabled: busy,
                                separatorBefore: true,
                                action: () => forkThreadAt(i),
                              },
                            ]
                          : []),
                        ...(!isApprovalMessage
                          ? [
                              {
                                id: "copy",
                                label: "Copy",
                                icon: <Copy size={13} />,
                                action: () =>
                                  void navigator.clipboard?.writeText(
                                    wireMessageContent(m),
                                  ),
                              },
                            ]
                          : []),
                        ...(m.role === "user"
                          ? [
                              {
                                id: "edit-resend",
                                label: "Edit and resend",
                                icon: <Pencil size={13} />,
                                disabled: busy,
                                action: () => setEditing(i),
                              },
                            ]
                          : []),
                        ...(m.role === "assistant" &&
                        !messageIsCompaction &&
                        !isApprovalMessage
                          ? [
                              {
                                id: "edit",
                                label: "Edit message",
                                icon: <Pencil size={13} />,
                                disabled: busy,
                                action: () => setEditing(i),
                              },
                            ]
                          : []),
                        ...(!messageIsCompaction
                          ? [
                              {
                                id: "delete",
                                label: "Delete message",
                                icon: <Trash size={13} />,
                                disabled: busy,
                                danger: true,
                                separatorBefore: true,
                                action: () => deleteMessageAt(i),
                              },
                            ]
                          : []),
                        ...(isLastAssistant
                          ? [
                              {
                                id: "regenerate",
                                label: "Regenerate",
                                icon: <Refresh size={13} />,
                                disabled: busy,
                                action: regenerate,
                              },
                            ]
                          : []),
                      ],
                      m.role === "assistant"
                        ? "Assistant message"
                        : "User message",
                    );
                  };
                  if (editing === i) {
                    return (
                      <div key={i} className={"msg " + m.role}>
                        <MessageEditor
                          initial={m.content}
                          saveLabel={m.role === "user" ? "Send" : "Save"}
                          onCancel={() => setEditing(null)}
                          onSave={(t) =>
                            m.role === "user"
                              ? editResend(i, t)
                              : editMessageInPlace(i, t)
                          }
                        />
                      </div>
                    );
                  }
                  return (
                    <div
                      key={i}
                      className={"msg " + m.role}
                      data-testid={
                        m.role === "assistant"
                          ? "assistant-message"
                          : "user-message"
                      }
                      onContextMenu={openMessageContextMenu}
                    >
                      <div className="msg-content">
                        {m.role === "assistant" ? (
                          <>
                            {m.run && m.run !== activeRun && (
                              <RunTimeline run={m.run} />
                            )}
                            {!hasStreamTranscript && (
                              <MemoryBreadcrumbs memories={m.memories} />
                            )}
                            {m.approval && (
                              <ToolApprovalCard
                                approval={m.approval}
                                disabled={busy || Boolean(activeMediaTarget)}
                                onApprove={() => approveToolApproval(i, m)}
                                onDeny={() => denyToolApproval(i, m)}
                              />
                            )}
                            {(hasAssistantOutput || assistantStreaming) && (
                              <AssistantMessage
                                content={m.content}
                                streamParts={m.streamParts}
                                previewArtifacts={previewArtifacts}
                                onOpenPreview={openMessagePreview}
                                streaming={busy && isLastAssistant}
                                previewArtifactsStreaming={
                                  previewArtifactsStreaming
                                }
                                workDurationMs={m.metrics?.durationMs}
                              />
                            )}
                            {renderMessageMedia(m.mediaResults)}
                            <AutomationCards
                              run={m.run}
                              onOpenSchedules={onOpenSchedules}
                            />
                            <ArtifactList
                              artifacts={m.artifacts}
                              currentSessionId={APP_SESSION_ID}
                              hiddenArtifactIds={hiddenArtifactIdsForMessage(
                                m,
                                !folder.trim(),
                              )}
                              onOpenPreview={openMessagePreview}
                              onSaveToWorkspace={(
                                artifact,
                                options,
                                revision,
                              ) =>
                                handleSaveArtifact(
                                  i,
                                  artifact,
                                  options,
                                  revision,
                                )
                              }
                              onPreviewArtifact={handlePreviewArtifact}
                              onCheckSavedArtifact={handleCheckArtifact}
                              onOpenSavedArtifact={handleOpenArtifact}
                              revisionForArtifact={(artifactIndex) =>
                                artifactRevisionChoice(i, artifactIndex)
                              }
                              autoSaveArtifacts={
                                toolApproval === "open" && !assistantStreaming
                              }
                              storageLabel={
                                folder.trim() ? "folder" : "virtual project"
                              }
                            />
                            {canStartRuntime && (
                              <div className="artifact-runtime-actions">
                                <button
                                  className="msg-act msg-act-text"
                                  data-testid="preview-app-start"
                                  title="Stage named files and start preview app"
                                  disabled={
                                    previewAppBusy != null ||
                                    isPreviewAppActive(previewAppStatus)
                                  }
                                  onClick={() =>
                                    void startPreviewRuntimeForArtifacts(
                                      m.artifacts,
                                    )
                                  }
                                >
                                  <Globe size={13} />
                                  <span>
                                    {previewAppBusy === "start"
                                      ? "Starting preview..."
                                      : "Start preview app"}
                                  </span>
                                </button>
                              </div>
                            )}
                            {metricsLabel && (
                              <div className="response-metrics">
                                {metricsLabel}
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            {m.content && <span>{m.content}</span>}
                            {renderMessageAttachments(m.attachments)}
                          </>
                        )}
                      </div>
                      <div className="msg-actions">
                        {canExecutePlan && (
                          <button
                            className="msg-act msg-act-text"
                            data-testid="execute-plan"
                            title="Execute plan"
                            onClick={() => executePlan(i, m)}
                          >
                            <ArrowRight size={13} />
                            <span>Execute plan</span>
                          </button>
                        )}
                        {m.role === "assistant" &&
                          !messageIsCompaction &&
                          m.content &&
                          ttsReady && (
                            <button
                              className="msg-act"
                              title="Speak"
                              aria-label="Speak"
                              onClick={() => void speakMessage(i, m.content)}
                            >
                              <Volume2 size={13} />
                            </button>
                          )}
                        {m.workspaceCheckpoint && !busy && (
                          <button
                            className="msg-act"
                            title="Restore workspace to before this turn"
                            aria-label="Restore workspace to before this turn"
                            onClick={() =>
                              void restoreWorkspaceCheckpoint(
                                m.workspaceCheckpoint!,
                              )
                            }
                          >
                            <Refresh size={13} />
                          </button>
                        )}
                        {!messageIsCompaction && !busy && (
                          <button
                            className="msg-act"
                            title="Branch from here"
                            aria-label="Branch from here"
                            onClick={() => forkThreadAt(i)}
                          >
                            <GitBranch size={13} />
                          </button>
                        )}
                        {!isApprovalMessage && (
                          <button
                            className="msg-act"
                            title="Copy"
                            onClick={() =>
                              navigator.clipboard?.writeText(
                                wireMessageContent(m),
                              )
                            }
                          >
                            <Copy size={13} />
                          </button>
                        )}
                        {m.role === "user" && !busy && (
                          <button
                            className="msg-act"
                            title="Edit & resend"
                            onClick={() => setEditing(i)}
                          >
                            <Pencil size={13} />
                          </button>
                        )}
                        {m.role === "assistant" &&
                          !messageIsCompaction &&
                          !isApprovalMessage &&
                          !busy && (
                            <button
                              className="msg-act"
                              title="Edit message"
                              aria-label="Edit message"
                              onClick={() => setEditing(i)}
                            >
                              <Pencil size={13} />
                            </button>
                          )}
                        {!messageIsCompaction && !busy && (
                          <button
                            className="msg-act danger"
                            title="Delete message"
                            aria-label="Delete message"
                            onClick={() => deleteMessageAt(i)}
                          >
                            <Trash size={13} />
                          </button>
                        )}
                        {isLastAssistant && !busy && (
                          <button
                            className="msg-act"
                            title="Regenerate"
                            onClick={regenerate}
                          >
                            <Refresh size={13} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="dock">
            {emptyThread && <MilimUsageRidgeline usage={milimUsage} />}
            {chatNotice && (
              <div
                className={`sheet-hint dock-notice ${chatNotice.tone}`}
                data-testid="chat-notice"
                role={chatNotice.tone === "error" ? "alert" : "status"}
                aria-live={chatNotice.tone === "error" ? "assertive" : "polite"}
              >
                {chatNotice.message}
              </div>
            )}
            <div className="dock-surface">
              <ControlBar
                models={pickerModels}
                model={model}
                onModel={(m) => updateThreadSettings(activeId, { model: m })}
                sandbox={sandbox}
                onToggleSandbox={() =>
                  updateThreadSettings(activeId, { sandbox: !sandbox })
                }
                computerUse={computerUse}
                onToggleComputer={() =>
                  updateThreadSettings(activeId, { computerUse: !computerUse })
                }
                memory={memory}
                onToggleMemory={() =>
                  updateThreadSettings(activeId, { memory: !memory })
                }
                planMode={planMode}
                onTogglePlanMode={() => setPlanModeActive(!planMode)}
                privacy={privacy}
                onCyclePrivacy={cyclePrivacy}
                toolApproval={toolApproval}
                onCycleToolApproval={cycleToolApproval}
                onManageProviders={() => setProvidersOpen(true)}
                onManageMcp={() => setMcpOpen(true)}
                onManageMemory={() => setMemoryOpen(true)}
                goal={goal}
                onOpenGoal={() => openGoalPanel()}
                activeRun={activeRun}
                inlineControls={
                  activeMediaTarget ? (
                    <InlineMediaControls
                      providerName={activeMediaTarget.provider.name}
                      model={activeMediaTarget.model}
                      kind={mediaKind}
                      supportedKinds={activeMediaTarget.supportedKinds}
                      schema={mediaSchema}
                      schemaLoading={mediaSchemaLoading}
                      parameterValues={mediaParameterValues}
                      advanced={mediaAdvanced}
                      error={mediaError}
                      onKindChange={setMediaKind}
                      onParameterChange={updateInlineMediaParameter}
                      onAdvancedChange={updateInlineMediaAdvanced}
                    />
                  ) : undefined
                }
              />
              <QueuedMessageTray
                items={queuedMessages}
                busy={busy}
                onRun={runQueuedMessages}
                onEdit={editQueuedMessage}
                onRemove={(id) => removeQueuedMessage(activeId, id)}
              />
              <Composer
                value={input}
                onChange={setInput}
                onSend={send}
                onStop={stop}
                attachments={pendingAttachments}
                onAttachFiles={handleAttachFiles}
                onAttachWorkspaceFile={handleAttachWorkspaceFile}
                onRemoveAttachment={(id) =>
                  setPendingAttachments((current) =>
                    current.filter((attachment) => attachment.id !== id),
                  )
                }
                onSlashCommand={runSlashCommand}
                agents={agents}
                activeAgentId={activeAgentId}
                onAgent={(agent) => {
                  const target = agent?.model || model;
                  updateThreadSettings(activeId, {
                    activeAgentId: agent?.id ?? null,
                    ...(target ? { model: target } : {}),
                  });
                }}
                onManageAgents={onManageAgents}
                instructions={instructions}
                onInstructions={(v) =>
                  updateThreadSettings(activeId, { instructions: v })
                }
                skills={skills}
                workspaceFolder={folder}
                workspaceProjects={workspaceProjects}
                onWorkspaceFolder={startChatInFolder}
                onPickWorkspaceFolder={() => void pickProjectFolder()}
                listWorkspaceFiles={listWorkspaceFiles}
                mediaActive={Boolean(activeMediaTarget)}
                mediaKind={
                  activeMediaTarget?.supportedKinds.includes(mediaKind)
                    ? mediaKind
                    : (activeMediaTarget?.kind ?? mediaKind)
                }
                mediaTargetLabel={
                  activeMediaTarget
                    ? `${activeMediaTarget.kind} / ${activeMediaTarget.provider.name}`
                    : undefined
                }
                sentHistory={sentHistory}
                tokens={tokens}
                contextBudgetTokens={activeContextBudget?.promptBudget}
                busy={busy}
              />
            </div>
          </div>
        </div>
        {sidePanelVisible && (
          <>
            <div
              className={`preview-resize-handle${previewResizing ? " dragging" : ""}${previewPanelClosing ? " closing" : ""}${sidePanelAlreadyOpen ? " no-enter" : ""}`}
              data-testid="preview-resize-handle"
              role="separator"
              aria-label="Resize side panel"
              aria-orientation="vertical"
              aria-valuemin={PREVIEW_PANEL_MIN_WIDTH}
              aria-valuemax={maxPreviewPanelWidth()}
              aria-valuenow={resolvedPreviewPanelWidth}
              tabIndex={previewPanelClosing ? -1 : 0}
              onKeyDown={resizePreviewWithKeyboard}
              onPointerDown={startPreviewResize}
              onPointerMove={movePreviewResize}
              onPointerUp={endPreviewResize}
              onPointerCancel={endPreviewResize}
            />
            {sidePanelMode === "git" ? (
              <GitWorkspacePanel
                folder={folder}
                model={effectiveModel}
                onDraftAction={loadGitActionDraft}
                closing={previewPanelClosing}
                noEnterMotion={sidePanelAlreadyOpen}
                onClose={closeGitPanel}
                modeSwitcher={sidePanelModeSwitcher}
                style={previewPanelStyle}
              />
            ) : (
              visiblePreviewSelection && (
                <PreviewPanel
                  artifact={visiblePreviewSelection.artifact}
                  artifacts={visiblePreviewSelection.artifacts}
                  revision={visiblePreviewSelection.revision}
                  revisionGroup={visiblePreviewSelection.revisionGroup}
                  previewDeferred={visiblePreviewSelection.previewDeferred}
                  closing={previewPanelClosing}
                  noEnterMotion={sidePanelAlreadyOpen}
                  onClose={closePreview}
                  onSelectRevision={selectPreviewRevision}
                  onOpenBrowser={openArtifactBrowser}
                  onSendArtifactFixPrompt={sendArtifactFixPrompt}
                  activeTab={
                    sidePanelMode === "artifact" &&
                    !visiblePreviewSelection.previewDeferred
                      ? artifactPanelTab
                      : undefined
                  }
                  onActiveTabChange={
                    sidePanelMode === "artifact" &&
                    !visiblePreviewSelection.previewDeferred
                      ? (tab) => setArtifactPanelTab(activeId, tab)
                      : undefined
                  }
                  runtimeStatus={
                    previewAppStatus ??
                    folderPreviewIdleStatus(activePreviewRuntimeKey, folder)
                  }
                  runtimeBusy={previewAppBusy != null}
                  onRuntimeStart={() => void startPreviewRuntime()}
                  onRuntimeStop={() => void stopPreviewRuntime()}
                  onRuntimeRestart={() => void restartPreviewRuntime()}
                  controlActivity={previewControlActivity}
                  modeSwitcher={sidePanelModeSwitcher}
                  style={previewPanelStyle}
                />
              )
            )}
          </>
        )}
      </div>

      {chatSearchOpen && (
        <ChatSearchPopover
          projects={projects}
          activeId={activeId}
          onSelect={switchToSession}
          onClose={() => setChatSearchOpen(false)}
        />
      )}

      <Suspense fallback={null}>
        {providersOpen && (
          <ProvidersManager
            onClose={() => {
              setProvidersOpen(false);
              listModelsDetailed().then(setModels);
              listProviders().then(setProviders);
            }}
          />
        )}

        {mcpOpen && showMcp && <McpManager onClose={() => setMcpOpen(false)} />}

        {memoryOpen && showMemoryManager && (
          <MemoryManager onClose={() => setMemoryOpen(false)} />
        )}

        {goalPanelOpen && (
          <GoalPanel
            goal={goal}
            prefillObjective={goalPrefill}
            onSave={(draft) => {
              saveGoalDraft(draft);
              setChatNotice({ tone: "info", message: "Goal saved." });
            }}
            onRun={(draft) => startGoalRun(draft)}
            onPause={() => pauseGoalRun()}
            onDelete={() => deleteGoal()}
            onClose={() => {
              setGoalPrefill(null);
              setGoalPanelOpen(false);
            }}
          />
        )}
      </Suspense>
    </div>
  );
}
