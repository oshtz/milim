// Thin client for the local milim server.

import { invoke } from "@tauri-apps/api/core";
import type { KokoroPreset, VoiceSettings } from "./settings/store";
import type { PiperPreset } from "./settings/store";
import type { VadPreset } from "./settings/store";
import { createSilentWav } from "./lib/recordWav";

export const MAX_ATTACHMENT_BYTES = 128 * 1024;

export interface ChatAttachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  content?: string;
  dataUrl?: string;
  truncated?: boolean;
  sourcePath?: string;
}

export interface WorkspaceFileSuggestion {
  path: string;
  full_path: string;
  name: string;
  size: number;
}

export type ChatArtifactKind = "code" | "json" | "csv" | "table" | "text";

export interface ChatArtifact {
  id: string;
  kind: ChatArtifactKind;
  title: string;
  mime: string;
  content: string;
  size: number;
  language?: string;
  filename?: string;
  saved?: SavedArtifactFile;
}

export interface SavedArtifactFile {
  path: string;
  bytes: number;
  overwritten: boolean;
  savedAt?: number;
  sourceSessionId?: string;
  sourceMessageIndex?: number;
  sourceRevisionNumber?: number;
  source?: "artifact" | "tool_write" | "auto_artifact";
}

export interface ArtifactFileStatus {
  path: string;
  exists: boolean;
  is_file: boolean;
  is_dir: boolean;
  bytes?: number | null;
}

export interface ArtifactWritePreview {
  path: string;
  exists: boolean;
  changed: boolean;
  old_content?: string | null;
  new_content: string;
  old_bytes?: number | null;
  new_bytes: number;
  diff: string;
  truncated: boolean;
}

export type ArtifactOpenTarget = "file" | "folder";

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompactionMetrics {
  responseCount: number;
  durationMs: number;
  usage: TokenUsage;
  costUsd?: number;
}

export interface ChatCompactionSummaryMetrics {
  model: string;
  provider?: string;
  durationMs?: number;
  usage?: TokenUsage;
  costUsd?: number;
}

export interface ChatCompactionCheckpoint {
  kind: "checkpoint";
  createdAt: number;
  sourceTokens: number;
  summaryTokens: number;
  auto?: boolean;
  /** Thread usage/cost total immediately before this checkpoint was created. */
  baseline?: ChatCompactionMetrics;
  /** Usage/cost of the model call that generated the checkpoint summary. */
  summary?: ChatCompactionSummaryMetrics;
}

export interface WorkspaceCheckpoint {
  ref: string;
  createdAt: number;
  folder: string;
  root?: string;
  head?: string;
}

export interface ChatApprovalRequest {
  kind: "tool";
  scope: "reply" | "goal";
  status: "pending" | "approved" | "denied";
  requestedAt: number;
  resolvedAt?: number;
  model?: string;
}

export interface ChatMessage {
  role: string;
  content: string;
  attachments?: ChatAttachment[];
  mediaResults?: MediaGenerationResult[];
  mediaRequestId?: string;
  compaction?: ChatCompactionCheckpoint;
  plan?: { status: "proposed" | "executed"; executedAt?: number };
  approval?: ChatApprovalRequest;
  artifacts?: ChatArtifact[];
  memories?: MemoryNotice[];
  /** UI-only ordered stream transcript of assistant text, reasoning, and events. */
  streamParts?: ChatStreamPart[];
  /** UI-only structured trace of an agent/tool run (never sent to the server). */
  run?: RunTrace;
  /** UI-only response timing, token usage, and optional estimated cost. */
  metrics?: ResponseMetrics;
  /** Git worktree snapshot captured immediately before this assistant turn. */
  workspaceCheckpoint?: WorkspaceCheckpoint;
}

export interface ProviderLimitInfo {
  provider: string;
  status?: string | null;
  kind?: string | null;
  reset_at?: number | null;
  remaining?: number | null;
  limit?: number | null;
  used?: number | null;
  used_percent?: number | null;
  label?: string | null;
  raw?: unknown;
}

export interface ResponseMetrics {
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  model: string;
  provider?: string;
  usage?: TokenUsage;
  costUsd?: number;
  limits?: ProviderLimitInfo[];
}

export type ChatStreamEventIcon =
  | "tool"
  | "file"
  | "command"
  | "memory"
  | "schedule"
  | "screen"
  | "thinking"
  | "error";

export type ChatStreamEventStatus = "running" | "done" | "error";

export type ChatStreamPart =
  | { kind: "text"; content: string }
  | { kind: "thinking"; content: string }
  | {
      kind: "event";
      eventType: "tool" | "memory" | "status" | "warning" | "error";
      label: string;
      detail?: string;
      name?: string;
      callId?: string;
      icon?: ChatStreamEventIcon;
      status?: ChatStreamEventStatus;
    };

export type RunStatus = "running" | "done" | "stopped" | "aborted" | "error";

/** One tool invocation within an agent run, with client-side timing. */
export interface RunStep {
  callId?: string;
  name: string;
  arguments?: string;
  result?: unknown;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/** Structured timeline of one agent/tool-use run, built from the AgentEvent
 *  stream and rendered as the run timeline in the chat UI. */
export interface RunTrace {
  model: string;
  startedAt: number;
  endedAt?: number;
  steps: RunStep[];
  workspace?: string;
  sourceSessionId?: string;
  iterations?: number;
  status: RunStatus;
  error?: string;
}

export function attachmentsToPromptContext(attachments?: ChatAttachment[]): string {
  if (!attachments?.length) return "";
  const blocks = attachments.map((attachment) => {
    const meta = [
      `name=${attachment.name}`,
      `mime=${attachment.mime || "application/octet-stream"}`,
      `size=${attachment.size}`,
      attachment.truncated ? `truncated_at=${MAX_ATTACHMENT_BYTES}` : null,
      attachment.sourcePath ? `path=${attachment.sourcePath}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const content = attachment.content?.trimEnd();
    const imageNote = attachment.dataUrl ? "[Image preview is available in the desktop UI. No OCR text was extracted.]" : "";
    return [
      `--- attachment ${meta} ---`,
      content ? content : imageNote || "[No text content available for this attachment.]",
      "--- end attachment ---",
    ].join("\n");
  });
  return ["[Attached files]", ...blocks, "[/Attached files]"].join("\n");
}

export function wireMessageContent(message: ChatMessage): string {
  if (message.approval) return "";
  const attachmentContext = attachmentsToPromptContext(message.attachments);
  if (!attachmentContext) return message.content;
  return message.content ? `${message.content}\n\n${attachmentContext}` : attachmentContext;
}

/** Strip UI-only fields so only the wire contract (`role`, `content`) is sent. */
function wireMessages(messages: ChatMessage[]): Array<{ role: string; content: string }> {
  return messages
    .filter((m) => !m.approval)
    .map((m) => ({ role: m.role, content: wireMessageContent(m) }));
}

const DEFAULT_BASE = "http://127.0.0.1:7377";
const BASE = DEFAULT_BASE;
const CODEX_PICKER_TIMEOUT_MS = 1500;
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let tokenPromise: Promise<string | null> | null = null;
let apiBasePromise: Promise<string> | null = null;

async function localApiToken(): Promise<string | null> {
  if (!inTauri) return null;
  tokenPromise ??= invoke<string>("api_token").catch(() => null);
  return tokenPromise;
}

async function localApiBaseUrl(): Promise<string> {
  if (!inTauri) return DEFAULT_BASE;
  apiBasePromise ??= invoke<string>("api_base_url").catch(() => DEFAULT_BASE);
  return apiBasePromise;
}

export async function apiBaseUrl(): Promise<string> {
  return await localApiBaseUrl();
}

export interface HarnessMcpCandidate {
  harness: string;
  name: string;
  command: string;
  args: string[];
  source_path: string;
}

export interface HarnessSkillCandidate {
  harness: string;
  name: string;
  path: string;
  skill_md: string;
}

export interface HarnessImportPreview {
  mcps: HarnessMcpCandidate[];
  skills: HarnessSkillCandidate[];
}

export async function discoverHarnessImports(): Promise<HarnessImportPreview> {
  if (!inTauri) return { mcps: [], skills: [] };
  try {
    return await invoke<HarnessImportPreview>("discover_harness_imports");
  } catch {
    return { mcps: [], skills: [] };
  }
}

async function resolveApiInput(input: RequestInfo | URL): Promise<RequestInfo | URL> {
  const base = await localApiBaseUrl();
  if (base === DEFAULT_BASE) return input;
  if (typeof input === "string") {
    return input.startsWith(DEFAULT_BASE) ? `${base}${input.slice(DEFAULT_BASE.length)}` : input;
  }
  if (input instanceof URL) {
    const text = input.toString();
    return text.startsWith(DEFAULT_BASE) ? new URL(`${base}${text.slice(DEFAULT_BASE.length)}`) : input;
  }
  return input;
}

export async function typeDictationText(text: string): Promise<void> {
  if (!inTauri) throw new Error("Active-app dictation is only available in the desktop app.");
  await invoke("voice_type_text", { text });
}

export async function readAttachmentFile(path: string): Promise<Omit<ChatAttachment, "id">> {
  if (!inTauri) throw new Error("Desktop file picking is only available in the desktop app.");
  const payload = await invoke<{
    name: string;
    size: number;
    content: string;
    truncated: boolean;
  }>("read_attachment_file", { path, maxBytes: MAX_ATTACHMENT_BYTES });
  return {
    name: payload.name,
    mime: inferAttachmentMime(payload.name),
    size: payload.size,
    content: payload.content,
    truncated: payload.truncated,
    sourcePath: path,
  };
}

export async function listWorkspaceFiles(workspace: string, query: string, limit = 20): Promise<WorkspaceFileSuggestion[]> {
  if (!inTauri || !workspace.trim()) return [];
  return await invoke<WorkspaceFileSuggestion[]>("list_workspace_files", { workspace, query, limit });
}

export async function saveArtifactFile(
  workspace: string,
  path: string,
  content: string,
  overwrite = false,
): Promise<SavedArtifactFile> {
  if (!inTauri) throw new Error("Saving artifacts to a working folder is only available in the desktop app.");
  return await invoke<SavedArtifactFile>("save_artifact_file", {
    workspace,
    path,
    content,
    overwrite,
  });
}

export async function previewArtifactFile(workspace: string, path: string, content: string): Promise<ArtifactWritePreview> {
  if (!inTauri) {
    return {
      path,
      exists: false,
      changed: content.length > 0,
      old_content: null,
      new_content: content,
      old_bytes: null,
      new_bytes: content.length,
      diff: content.split(/\r?\n/).map((line) => `+${line}`).join("\n"),
      truncated: false,
    };
  }
  return await invoke<ArtifactWritePreview>("preview_artifact_file", {
    workspace,
    path,
    content,
  });
}

export async function artifactFileStatus(path: string): Promise<ArtifactFileStatus> {
  if (!inTauri) {
    return { path, exists: true, is_file: true, is_dir: false, bytes: null };
  }
  return await invoke<ArtifactFileStatus>("artifact_file_status", { path });
}

export async function openArtifactLocation(path: string, target: ArtifactOpenTarget = "file"): Promise<void> {
  if (!inTauri) throw new Error("Opening saved artifacts is only available in the desktop app.");
  await invoke("open_artifact_location", { path, target });
}

export async function openExternalUrl(url: string): Promise<void> {
  if (inTauri) {
    await invoke("open_external_url", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

export function inferAttachmentMime(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "json":
      return "application/json";
    case "csv":
      return "text/csv";
    case "html":
    case "htm":
      return "text/html";
    case "css":
      return "text/css";
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
    case "rs":
    case "py":
    case "go":
    case "java":
    case "c":
    case "cpp":
    case "h":
    case "hpp":
    case "toml":
    case "yaml":
    case "yml":
    case "xml":
    case "txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const [token, resolvedInput] = await Promise.all([localApiToken(), resolveApiInput(input)]);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(resolvedInput, { ...init, headers });
}

export interface MobileCompanionPairing {
  id: string;
  expires_at: number;
  path: string;
}

export interface MobileCompanionDevice {
  id: string;
  name: string;
  key_prefix: string;
  paired_at: number;
  last_seen_at?: number | null;
}

export interface MobileCompanionStatus {
  enabled: boolean;
  pairing?: MobileCompanionPairing | null;
  devices: MobileCompanionDevice[];
  queued_events: number;
}

export interface MobileTailscaleStatus {
  installed: boolean;
  logged_in: boolean;
  serve_configured: boolean;
  public_url?: string | null;
  local_target: string;
  message?: string | null;
}

export type MobileRelayAction =
  | "append"
  | "replace"
  | "send"
  | "switch_thread"
  | "new_thread"
  | "stop"
  | "regenerate"
  | "delete_message"
  | "rename_thread"
  | "archive_thread"
  | "delete_thread"
  | "set_model"
  | "attach";

export type MobileRelayAttachment = Pick<ChatAttachment, "id" | "name" | "mime" | "size" | "content" | "dataUrl" | "truncated">;

export interface MobileRelayEvent {
  id: number;
  device_id: string;
  device_name: string;
  text: string;
  action: MobileRelayAction;
  attachments?: MobileRelayAttachment[];
  received_at: number;
}

export interface MobileThreadMessage {
  role: string;
  content: string;
}

export interface MobileThemeSnapshot {
  is_dark: boolean;
  css_vars: Record<string, string>;
  background_fit?: string;
  background_treatment?: string;
}

export interface MobileThreadSnapshot {
  session_id: string;
  title: string;
  model?: string | null;
  busy: boolean;
  messages: MobileThreadMessage[];
  threads?: MobileThreadSummary[];
  groups?: MobileThreadGroup[];
  models?: MobileModelSummary[];
  theme?: MobileThemeSnapshot;
}

export interface MobileThreadSummary {
  id: string;
  title: string;
  model?: string | null;
  updated_at: number;
  busy?: boolean;
  parent_id?: string | null;
  project_label?: string | null;
  project_path?: string | null;
}

export interface MobileThreadGroup {
  id: string;
  label: string;
  subtitle?: string | null;
  project_id?: string | null;
  threads: MobileThreadSummary[];
}

export interface MobileModelSummary {
  id: string;
  provider?: string | null;
}

async function parseJsonResponse<T>(resp: Response, fallback: string): Promise<T> {
  if (!resp.ok) throw new Error(await responseErrorMessage(resp, fallback));
  return (await resp.json()) as T;
}

export async function getMobileCompanionStatus(): Promise<MobileCompanionStatus> {
  return await parseJsonResponse<MobileCompanionStatus>(
    await authFetch(`${BASE}/mobile/status`),
    "mobile companion status failed",
  );
}

export async function setMobileCompanionEnabled(enabled: boolean): Promise<MobileCompanionStatus> {
  return await parseJsonResponse<MobileCompanionStatus>(
    await authFetch(`${BASE}/mobile/enabled`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    }),
    "mobile companion update failed",
  );
}

export async function startMobileCompanionPairing(): Promise<MobileCompanionPairing> {
  return await parseJsonResponse<MobileCompanionPairing>(
    await authFetch(`${BASE}/mobile/pairing`, { method: "POST" }),
    "mobile companion pairing failed",
  );
}

export async function revokeMobileCompanionDevice(id: string): Promise<MobileCompanionStatus> {
  return await parseJsonResponse<MobileCompanionStatus>(
    await authFetch(`${BASE}/mobile/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
    "mobile companion revoke failed",
  );
}

export async function pollMobileCompanionEvents(): Promise<MobileRelayEvent[]> {
  const payload = await parseJsonResponse<{ events: MobileRelayEvent[] }>(
    await authFetch(`${BASE}/mobile/events`),
    "mobile companion event poll failed",
  );
  return payload.events;
}

export async function publishMobileThreadSnapshot(snapshot: MobileThreadSnapshot): Promise<void> {
  await parseJsonResponse<{ thread: unknown }>(
    await authFetch(`${BASE}/mobile/thread`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snapshot),
    }),
    "mobile thread publish failed",
  );
}

export async function mobileTailscaleStatus(): Promise<MobileTailscaleStatus> {
  if (!inTauri) {
    return { installed: false, logged_in: false, serve_configured: false, local_target: "", message: "Tailscale setup is available in the desktop app." };
  }
  return await invoke<MobileTailscaleStatus>("mobile_tailscale_status");
}

export async function configureMobileTailscaleRelay(): Promise<MobileTailscaleStatus> {
  if (!inTauri) {
    return { installed: false, logged_in: false, serve_configured: false, local_target: "", message: "Tailscale setup is available in the desktop app." };
  }
  return await invoke<MobileTailscaleStatus>("configure_mobile_tailscale_relay");
}

export async function disableMobileTailscaleRelay(): Promise<MobileTailscaleStatus> {
  if (!inTauri) {
    return { installed: false, logged_in: false, serve_configured: false, local_target: "", message: "Tailscale setup is available in the desktop app." };
  }
  return await invoke<MobileTailscaleStatus>("disable_mobile_tailscale_relay");
}

/// Stream a chat completion, invoking `onToken` for each content delta.
export async function streamChat(
  model: string,
  messages: ChatMessage[],
  onToken: (t: string) => void,
  signal?: AbortSignal,
  onReasoning?: (t: string) => void,
  onUsage?: (usage: TokenUsage) => void,
  reasoningEffort?: ReasoningEffort,
): Promise<void> {
  const resp = await authFetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: wireMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
      ...reasoningEffortBody(reasoningEffort),
    }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    throw new Error(await responseErrorMessage(resp, `chat HTTP ${resp.status}`));
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        // ignore keepalives / partial frames
        continue;
      }

      const error = json.error?.message ?? json.error;
      if (error) throw new Error(String(error));
      const usage = parseTokenUsage(json.usage);
      if (usage) onUsage?.(usage);
      const delta: string | undefined = json.choices?.[0]?.delta?.content;
      const reasoning: string | undefined =
        json.choices?.[0]?.delta?.reasoning_content ?? json.choices?.[0]?.delta?.reasoning;
      if (reasoning) onReasoning?.(reasoning);
      if (delta) onToken(delta);
    }
  }
}

function reasoningEffortBody(reasoningEffort?: ReasoningEffort): { reasoning_effort?: ReasoningEffort } {
  return reasoningEffort && reasoningEffort !== "auto" ? { reasoning_effort: reasoningEffort } : {};
}

export interface ChatCompletionResult {
  content: string;
  usage?: TokenUsage;
}

export async function completeChatWithMetrics(
  model: string,
  messages: ChatMessage[],
  options: { signal?: AbortSignal; maxTokens?: number; temperature?: number } = {},
): Promise<ChatCompletionResult> {
  const resp = await authFetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: wireMessages(messages),
      stream: false,
      temperature: options.temperature ?? 0,
      max_tokens: options.maxTokens ?? 500,
    }),
    signal: options.signal,
  });
  if (!resp.ok) {
    throw new Error(await responseErrorMessage(resp, `chat HTTP ${resp.status}`));
  }
  const json = await resp.json();
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("The model returned an empty response.");
  const usage = parseTokenUsage(json.usage);
  return usage ? { content, usage } : { content };
}

export async function completeChat(
  model: string,
  messages: ChatMessage[],
  options: { signal?: AbortSignal; maxTokens?: number; temperature?: number } = {},
): Promise<string> {
  const { content } = await completeChatWithMetrics(model, messages, options);
  return content;
}

function parseTokenUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const prompt = usage.prompt_tokens;
  const completion = usage.completion_tokens;
  const total = usage.total_tokens;
  if (typeof prompt !== "number" || typeof completion !== "number" || typeof total !== "number") return null;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

/// List available models (returns [] if the server is unreachable or slow).
export async function listModels(): Promise<string[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await authFetch(`${BASE}/v1/models`, { signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r.json();
    return (j.data ?? []).map((m: { id: string }) => m.id).filter(isUsableChatModel);
  } catch {
    return [];
  }
}

export interface ModelInfo {
  id: string;
  owned_by: string;
  context_length?: number;
  max_prompt_tokens?: number;
  max_completion_tokens?: number;
  reasoning?: ModelReasoningMetadata;
  capabilities?: {
    imageInput?: boolean;
    imageOutput?: boolean;
    videoOutput?: boolean;
  };
}

export type ReasoningEffort = "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelReasoningMetadata {
  supported_efforts: ReasoningEffort[];
  default_effort?: ReasoningEffort;
  default_enabled?: boolean;
  mandatory?: boolean;
}

export const CODEX_MODEL_PREFIX = "codex:";
export const CLAUDE_MODEL_PREFIX = "claude:";

export function isCodexModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith(CODEX_MODEL_PREFIX);
}

export function isClaudeModel(model: string): boolean {
  return model.trim().toLowerCase().startsWith(CLAUDE_MODEL_PREFIX);
}

export function isAccountRuntimeModel(model: string): boolean {
  return isCodexModel(model) || isClaudeModel(model);
}

export function codexRuntimeModel(model: string): string | null {
  const trimmed = model.trim();
  return trimmed.toLowerCase().startsWith(CODEX_MODEL_PREFIX)
    ? trimmed.slice(CODEX_MODEL_PREFIX.length).trim() || null
    : null;
}

export function claudeRuntimeModel(model: string): string | null {
  const trimmed = model.trim();
  return trimmed.toLowerCase().startsWith(CLAUDE_MODEL_PREFIX)
    ? trimmed.slice(CLAUDE_MODEL_PREFIX.length).trim() || null
    : null;
}

export function isUsableChatModel(model: string): boolean {
  const id = model.trim().toLowerCase();
  return id.length > 0 && id !== "mock-echo";
}

/** Models with their provider (`owned_by`) for grouping in the picker. */
export async function listModelsDetailed(): Promise<ModelInfo[]> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await authFetch(`${BASE}/v1/models`, { signal: ctrl.signal });
    clearTimeout(timer);
    const j = await r.json();
    const localModels = (j.data ?? [])
      .map((m: { id: string; owned_by?: string; context_length?: number; max_prompt_tokens?: number; max_completion_tokens?: number; reasoning?: unknown }) => ({
        id: m.id,
        owned_by: m.owned_by ?? "local",
        context_length: numberOrUndefined(m.context_length),
        max_prompt_tokens: numberOrUndefined(m.max_prompt_tokens),
        max_completion_tokens: numberOrUndefined(m.max_completion_tokens),
        reasoning: normalizeModelReasoning(m.reasoning),
      }))
      .filter((m: ModelInfo) => isUsableChatModel(m.id));
    const [codexModels, claudeModels] = await Promise.all([
      listCodexModelsForPicker(),
      listClaudeModelsForPicker(),
    ]);
    return [...localModels, ...codexModels, ...claudeModels];
  } catch {
    return [];
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

const REASONING_EFFORTS: ReasoningEffort[] = ["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

function normalizeModelReasoning(value: unknown): ModelReasoningMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const supported = Array.isArray(raw.supported_efforts)
    ? raw.supported_efforts.filter((item): item is ReasoningEffort =>
        typeof item === "string" && REASONING_EFFORTS.includes(item as ReasoningEffort))
    : [];
  const defaultEffort = typeof raw.default_effort === "string" && REASONING_EFFORTS.includes(raw.default_effort as ReasoningEffort)
    ? raw.default_effort as ReasoningEffort
    : undefined;
  if (!supported.length && !defaultEffort && typeof raw.default_enabled !== "boolean" && typeof raw.mandatory !== "boolean") return undefined;
  return {
    supported_efforts: supported,
    default_effort: defaultEffort,
    default_enabled: typeof raw.default_enabled === "boolean" ? raw.default_enabled : undefined,
    mandatory: typeof raw.mandatory === "boolean" ? raw.mandatory : undefined,
  };
}

function normalizeReasoningEffort(value: unknown): ReasoningEffort | undefined {
  return typeof value === "string" && REASONING_EFFORTS.includes(value as ReasoningEffort)
    ? value as ReasoningEffort
    : undefined;
}

function normalizeCodexReasoning(item: any): ModelReasoningMetadata | undefined {
  const supported = Array.isArray(item?.supportedReasoningEfforts)
    ? item.supportedReasoningEfforts
        .map((entry: any) => normalizeReasoningEffort(entry?.reasoningEffort))
        .filter((effort: ReasoningEffort | undefined): effort is ReasoningEffort => Boolean(effort))
    : [];
  const defaultEffort = normalizeReasoningEffort(item?.defaultReasoningEffort);
  if (!supported.length && !defaultEffort) return undefined;
  return {
    supported_efforts: Array.from(new Set(supported)),
    default_effort: defaultEffort,
    default_enabled: true,
    mandatory: false,
  };
}

async function listCodexModelsForPicker(): Promise<ModelInfo[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CODEX_PICKER_TIMEOUT_MS);
  try {
    const account = await getCodexAccount(false, ctrl.signal);
    if (!account.account && account.requiresOpenaiAuth) return [];

    const r = await authFetch(`${BASE}/codex/models`, { signal: ctrl.signal });
    if (!r.ok) return [];
    const j = await r.json();
    const byId = new Map<string, ModelInfo>();
    for (const item of j.data ?? []) {
      const raw = typeof item?.model === "string" && item.model.trim()
        ? item.model.trim()
        : typeof item?.id === "string"
          ? item.id.trim()
          : "";
      if (!raw) continue;
      const inputModalities = Array.isArray(item?.inputModalities) ? item.inputModalities : [];
      byId.set(`${CODEX_MODEL_PREFIX}${raw}`, {
        id: `${CODEX_MODEL_PREFIX}${raw}`,
        owned_by: "Codex",
        reasoning: normalizeCodexReasoning(item),
        capabilities: {
          imageInput: inputModalities.includes("image"),
        },
      });
    }
    return Array.from(byId.values());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export interface CodexAccountResponse {
  requiresOpenaiAuth: boolean;
  account?: {
    type: string;
    email?: string;
    planType?: string;
  } | null;
}

export interface ClaudeStatusResponse {
  available: boolean;
  authenticated: boolean;
  warning?: boolean;
  auth?: {
    loggedIn?: boolean;
    authMethod?: string;
    email?: string;
    subscriptionType?: string;
  };
  models?: string[];
  error?: string | null;
}

export type CodexLoginEvent =
  | { type: "browser"; login_id: string; auth_url: string }
  | { type: "device_code"; login_id: string; user_code: string; verification_url: string }
  | { type: "done"; success: boolean; error?: string | null }
  | { type: "warning"; message: string }
  | { type: "error"; message: string };

export type CodexRunEvent =
  | { type: "thread"; thread_id: string; model: string }
  | { type: "start"; thread_id: string; turn_id: string }
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name: string; status: ChatStreamEventStatus; label?: string | null; detail?: string | null; icon?: ChatStreamEventIcon | null }
  | { type: "image"; id: string; status: string; url: string; revised_prompt?: string | null; saved_path?: string | null }
  | { type: "done"; thread_id: string; turn_id?: string | null; status: string; usage?: TokenUsage; cost_usd?: number }
  | { type: "warning"; message: string }
  | { type: "error"; message: string; usage?: TokenUsage; cost_usd?: number };

export type ClaudeRunEvent =
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool"; id: string; name: string; status: ChatStreamEventStatus; label?: string | null; detail?: string | null; icon?: ChatStreamEventIcon | null }
  | { type: "rate_limit"; limit: ProviderLimitInfo }
  | { type: "done"; status: string; usage?: TokenUsage; cost_usd?: number }
  | { type: "warning"; message: string }
  | { type: "error"; message: string; usage?: TokenUsage; cost_usd?: number };

export function isCliPathWarningMessage(message?: string | null): boolean {
  return Boolean(message?.includes("CLI was not found on PATH"));
}

export async function getCodexAccount(refresh = false, signal?: AbortSignal): Promise<CodexAccountResponse> {
  const url = new URL(`${BASE}/codex/account`);
  if (refresh) url.searchParams.set("refresh", "true");
  return await parseJsonResponse<CodexAccountResponse>(
    await authFetch(url, signal ? { signal } : undefined),
    "Codex account check failed",
  );
}

export async function logoutCodex(): Promise<void> {
  await parseJsonResponse<unknown>(
    await authFetch(`${BASE}/codex/logout`, { method: "POST" }),
    "Codex logout failed",
  );
}

export async function getCodexRateLimits(): Promise<unknown> {
  return await parseJsonResponse<unknown>(
    await authFetch(`${BASE}/codex/rate-limits`),
    "Codex rate limit check failed",
  );
}

async function listClaudeModelsForPicker(): Promise<ModelInfo[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CODEX_PICKER_TIMEOUT_MS);
  try {
    const status = await getClaudeStatus(ctrl.signal);
    if (!status.available || !status.authenticated) return [];
    return (status.models ?? [])
      .filter((model) => model.trim())
      .map((model) => ({
        id: `${CLAUDE_MODEL_PREFIX}${model.trim()}`,
        owned_by: "Claude Code",
        reasoning: {
          supported_efforts: ["low", "medium", "high", "xhigh", "max"],
          default_effort: "high",
          default_enabled: true,
          mandatory: false,
        },
      }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export async function getClaudeStatus(signal?: AbortSignal): Promise<ClaudeStatusResponse> {
  return await parseJsonResponse<ClaudeStatusResponse>(
    await authFetch(`${BASE}/claude/status`, signal ? { signal } : undefined),
    "Claude Code status check failed",
  );
}

export async function streamCodexDeviceLogin(
  onEvent: (ev: CodexLoginEvent) => void,
  signal?: AbortSignal,
  method: "chatgpt" | "chatgpt_device_code" = "chatgpt",
): Promise<void> {
  const path = method === "chatgpt_device_code" ? "/codex/login/chatgpt-device" : "/codex/login/device";
  const resp = await authFetch(`${BASE}${path}`, { method: "POST", signal });
  if (!resp.ok || !resp.body) throw new Error(await responseErrorMessage(resp, `Codex login HTTP ${resp.status}`));
  await streamJsonSse(resp, onEvent);
}

export async function loginCodexApiKey(apiKey: string): Promise<unknown> {
  return await parseJsonResponse<unknown>(
    await authFetch(`${BASE}/codex/login/api-key`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey }),
    }),
    "Codex API-key login failed",
  );
}

export async function streamCodexRun(
  request: {
    model: string;
    prompt: string;
    cwd?: string;
    reasoning_effort?: ReasoningEffort;
    thread_id?: string;
    persist_thread?: boolean;
    tool_approval_policy?: ToolApprovalMode;
    tool_approval_grant?: boolean;
    plan_mode?: boolean;
  },
  onEvent: (ev: CodexRunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await authFetch(`${BASE}/codex/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!resp.ok || !resp.body) throw new Error(await responseErrorMessage(resp, `Codex run HTTP ${resp.status}`));
  await streamJsonSse(resp, onEvent);
}

export async function streamClaudeRun(
  request: {
    model: string;
    prompt: string;
    cwd?: string;
    reasoning_effort?: ReasoningEffort;
    session_id?: string;
    tool_approval_policy?: ToolApprovalMode;
    tool_approval_grant?: boolean;
    plan_mode?: boolean;
  },
  onEvent: (ev: ClaudeRunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await authFetch(`${BASE}/claude/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!resp.ok || !resp.body) throw new Error(await responseErrorMessage(resp, `Claude Code run HTTP ${resp.status}`));
  await streamJsonSse(resp, onEvent);
}

async function streamJsonSse<T>(resp: Response, onEvent: (ev: T) => void): Promise<void> {
  const reader = resp.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      let parsed: T;
      try {
        parsed = JSON.parse(data) as T;
      } catch {
        /* keepalive / partial */
        continue;
      }
      onEvent(parsed);
    }
  }
}

// ----- Agents -----

export type AgentToolMode = "all" | "custom" | "none";
export type AgentSkillMode = "auto" | "custom" | "none";

export interface Agent {
  id: string;
  name: string;
  system_prompt: string;
  model: string;
  tool_mode: AgentToolMode;
  enabled_tools: string[];
  skill_mode: AgentSkillMode;
  enabled_skills: string[];
  avatar: string;
}

export interface AgentDraft {
  name: string;
  system_prompt: string;
  avatar: string;
}

const AGENT_DRAFT_SYSTEM_PROMPT = [
  "You generate reusable Milim agent profiles.",
  "Return only one JSON object with string fields: name, avatar, system_prompt.",
  "name: concise display name, usually 2-4 words.",
  "avatar: one relevant emoji or a 1-2 character plain-text label.",
  "system_prompt: directly usable as an agent system prompt. Include role, priorities, behavior, boundaries, and output style.",
  "Do not include markdown, code fences, comments, explanations, or extra fields.",
].join("\n");

function graphemes(text: string): string[] {
  const Segmenter = (Intl as any).Segmenter;
  if (Segmenter) {
    return Array.from(new Segmenter(undefined, { granularity: "grapheme" }).segment(text), (x: any) => String(x.segment));
  }
  return Array.from(text);
}

export function isLegacyAgentAvatar(value: string): boolean {
  return value.startsWith("data:") || value.startsWith("/images/") || /\.(png|jpe?g|webp|gif)$/i.test(value);
}

/** Text badge for an agent avatar. User-provided emoji or short labels win;
 *  old bundled image values fall back to the agent initial. */
export function agentAvatarText(agent: { name?: string; avatar?: string }): string {
  const raw = (agent.avatar ?? "").trim();
  if (raw && !isLegacyAgentAvatar(raw)) return graphemes(raw).slice(0, 2).join("");
  const name = (agent.name ?? "").trim();
  return graphemes(name)[0]?.toUpperCase() ?? "?";
}

export function isAgentDraftModel(model: string): boolean {
  return isUsableChatModel(model);
}

function cleanDraftText(value: unknown, maxLength: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("The model returned an empty draft.");
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return extractJsonObject(fence[1]);

  const start = trimmed.indexOf("{");
  if (start < 0) throw new Error("The model did not return agent JSON.");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }

  throw new Error("The model returned incomplete agent JSON.");
}

export function parseAgentDraftResponse(text: string): AgentDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("The model returned invalid agent JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The model returned invalid agent JSON.");
  }

  const raw = parsed as Record<string, unknown>;
  const name = cleanDraftText(raw.name, 60).replace(/\s+/g, " ");
  const systemPrompt = cleanDraftText(raw.system_prompt ?? raw.systemPrompt, 6000);
  const rawAvatar = cleanDraftText(raw.avatar, 8);
  const avatar = rawAvatar && !isLegacyAgentAvatar(rawAvatar)
    ? graphemes(rawAvatar).slice(0, 2).join("")
    : agentAvatarText({ name });

  if (!name) throw new Error("The model returned a draft without a name.");
  if (!systemPrompt) throw new Error("The model returned a draft without a system prompt.");

  return { name, system_prompt: systemPrompt, avatar };
}

export interface ToolInfo {
  name: string;
  description: string;
}

export async function listAgents(): Promise<Agent[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await authFetch(`${BASE}/agents`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    return (j.agents ?? []).map(normalizeAgent);
  } catch {
    return [];
  }
}

export async function saveAgent(a: Omit<Agent, "id"> & { id?: string }): Promise<Agent | null> {
  const body = JSON.stringify({
    name: a.name,
    model: a.model,
    system_prompt: a.system_prompt,
    tool_mode: a.tool_mode,
    enabled_tools: a.enabled_tools,
    skill_mode: a.skill_mode,
    enabled_skills: a.enabled_skills,
    avatar: a.avatar,
  });
  const headers = { "Content-Type": "application/json" };
  try {
    const r = a.id
      ? await authFetch(`${BASE}/agents/${encodeURIComponent(a.id)}`, { method: "PUT", headers, body })
      : await authFetch(`${BASE}/agents`, { method: "POST", headers, body });
    return r.ok ? normalizeAgent(await r.json()) : null;
  } catch {
    return null;
  }
}

export async function generateAgentDraft(prompt: string, model: string): Promise<AgentDraft> {
  const request = prompt.trim();
  if (!request) throw new Error("Describe the agent first.");
  const draftModel = model.trim();
  if (!isAgentDraftModel(draftModel)) throw new Error("Choose a model before drafting an agent.");

  const r = await authFetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: draftModel,
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: "system", content: AGENT_DRAFT_SYSTEM_PROMPT },
        { role: "user", content: `Draft an agent profile from this request:\n${request}` },
      ],
    }),
  });

  if (!r.ok) {
    throw new Error(await responseErrorMessage(r, `agent draft HTTP ${r.status}`));
  }

  const json = await r.json();
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("The model returned an empty draft.");
  return parseAgentDraftResponse(content);
}

function normalizeAgent(a: Partial<Agent> & { enabled_tools?: string[] }): Agent {
  const enabledTools = a.enabled_tools ?? [];
  const toolMode = a.tool_mode === "all" || a.tool_mode === "custom" || a.tool_mode === "none"
    ? a.tool_mode
    : enabledTools.length === 0
      ? "all"
      : "custom";
  const enabledSkills = a.enabled_skills ?? [];
  const skillMode = a.skill_mode === "auto" || a.skill_mode === "custom" || a.skill_mode === "none"
    ? a.skill_mode
    : enabledSkills.length === 0
      ? "auto"
      : "custom";
  const model = a.model ?? "";
  return {
    id: a.id ?? "",
    name: a.name ?? "",
    system_prompt: a.system_prompt ?? "",
    model: isUsableChatModel(model) ? model : "",
    tool_mode: toolMode,
    enabled_tools: enabledTools,
    skill_mode: skillMode,
    enabled_skills: enabledSkills,
    avatar: a.avatar ?? "",
  };
}

export async function deleteAgent(id: string): Promise<boolean> {
  try {
    const r = await authFetch(`${BASE}/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}

export async function listTools(): Promise<ToolInfo[]> {
  try {
    const r = await authFetch(`${BASE}/mcp/tools`);
    const j = await r.json();
    return (j.tools ?? []).map((t: { name: string; description?: string }) => ({
      name: t.name,
      description: t.description ?? "",
    }));
  } catch {
    return [];
  }
}

/** Stream a server-side agent run (tool-use loop) via SSE. Calls onEvent for
 *  each parsed AgentEvent. Uses /agents/{id}/run when agentId is set, else
 *  /agents/run. */
export async function streamAgentRun(
  agentId: string | null,
  model: string,
  messages: ChatMessage[],
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal,
  memoryContext?: AgentMemoryContext,
  toolContext?: AgentToolContext,
  reasoningEffort?: ReasoningEffort,
): Promise<void> {
  const url = agentId ? `${BASE}/agents/${encodeURIComponent(agentId)}/run` : `${BASE}/agents/run`;
  const resp = await authFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: wireMessages(messages),
      stream: true,
      ...(memoryContext ?? {}),
      ...(toolContext ?? {}),
      ...reasoningEffortBody(reasoningEffort),
    }),
    signal,
  });
  if (!resp.ok || !resp.body) throw new Error(await responseErrorMessage(resp, `agent run HTTP ${resp.status}`));

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        onEvent(JSON.parse(data) as AgentEvent);
      } catch {
        /* keepalive / partial */
      }
    }
  }
}

export interface AgentMemoryContext {
  memory_enabled?: boolean;
  thread_id?: string;
  thread_label?: string;
  project_locator?: string;
  project_label?: string;
  message_id?: string;
}

export type ToolApprovalMode = "review" | "guarded" | "open";

export interface AgentToolContext {
  tool_approval_policy?: ToolApprovalMode;
  tool_approval_grant?: boolean;
  sandbox_enabled?: boolean;
  computer_use_enabled?: boolean;
  experimental_hashline_patch?: boolean;
  plan_mode?: boolean;
}

export type ChildThreadStatus = "queued" | "running" | "done" | "stopped" | "error";

export interface ChildThreadInfo {
  id: string;
  parent_id: string;
  root_id: string;
  title: string;
  status: ChildThreadStatus;
  model: string;
  agent_id?: string | null;
  prompt: string;
  summary?: string | null;
  error?: string | null;
  created_at: string;
  updated_at: string;
  finished_at?: string | null;
}

export interface ThreadEvent {
  id: string;
  thread_id: string;
  kind: string;
  payload: unknown;
  created_at: string;
}

export async function streamChildThreadEvents(
  parentId: string,
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const resp = await authFetch(`${BASE}/threads/${encodeURIComponent(parentId)}/events`, signal ? { signal } : undefined);
  if (!resp.ok || !resp.body) throw new Error(await responseErrorMessage(resp, `child thread events HTTP ${resp.status}`));
  await streamJsonSse(resp, onEvent);
}

export async function stopChildThread(id: string): Promise<ChildThreadInfo> {
  const data = await parseJsonResponse<{ thread: ChildThreadInfo }>(
    await authFetch(`${BASE}/threads/${encodeURIComponent(id)}/stop`, { method: "POST" }),
    `child thread stop HTTP failed`,
  );
  return data.thread;
}

export async function deleteThreadTree(id: string): Promise<void> {
  await parseJsonResponse<{ deleted: number }>(
    await authFetch(`${BASE}/threads/${encodeURIComponent(id)}`, { method: "DELETE" }),
    `thread delete HTTP failed`,
  );
}

/** A parsed SSE event from an agent run (milim-agents `AgentEvent`, tagged by
 *  `type`). */
export interface AgentEvent {
  type?:
    | "start"
    | "token"
    | "reasoning"
    | "tool_call"
    | "tool_result"
    | "memory_registered"
    | "child_thread_started"
    | "child_thread_done"
    | "child_thread_error"
    | "child_thread_event"
    | "final"
    | "done"
    | "error";
  text?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  result?: unknown;
  content?: string;
  message?: string;
  iterations?: number;
  /** `start`: the model that actually ran (agent runs may override the request). */
  model?: string;
  /** Legacy field; current agent runs do not stop at an iteration limit. */
  stopped_at_limit?: boolean;
  usage?: TokenUsage;
  id?: string;
  node_id?: string;
  scope_kind?: MemoryScopeKind;
  scope_label?: string;
  summary?: string;
  created_at?: string;
  thread?: ChildThreadInfo;
  event?: ThreadEvent;
}

/** Transcribe a WAV blob via the server's STT endpoint. Throws on error
 *  (e.g. voice not enabled / no model). */
export async function transcribe(wav: Blob, voice?: VoiceSettings, signal?: AbortSignal): Promise<string> {
  if (voice?.serverVadEnabled) {
    const activity = await detectSpeech(wav, voice, signal);
    if (!activity.is_speech) return "";
  }

  const url = new URL(`${BASE}/audio/transcriptions`);
  const headers = new Headers({ "Content-Type": "audio/wav" });
  if (voice?.provider === "whisper" && voice.whisperModelPath.trim()) {
    url.searchParams.set("provider", "whisper");
    url.searchParams.set("model_path", voice.whisperModelPath.trim());
  } else if (voice?.provider === "openai" && voice.openAiEndpoint.trim() && voice.openAiModel.trim()) {
    url.searchParams.set("provider", "openai");
    url.searchParams.set("endpoint", voice.openAiEndpoint.trim());
    url.searchParams.set("model", voice.openAiModel.trim());
    if (voice.openAiApiKey.trim()) headers.set("X-Milim-STT-Api-Key", voice.openAiApiKey.trim());
  } else if (voice?.provider === "remote" && voice.remoteEndpoint.trim()) {
    url.searchParams.set("provider", "remote");
    url.searchParams.set("endpoint", voice.remoteEndpoint.trim());
  } else if (voice?.provider === "parakeet" && voice.parakeetCommand.trim()) {
    url.searchParams.set("provider", "parakeet");
    url.searchParams.set("command", voice.parakeetCommand.trim());
    if (voice.parakeetModel.trim()) url.searchParams.set("model", voice.parakeetModel.trim());
  }

  const resp = await authFetch(url, {
    method: "POST",
    headers,
    body: wav,
    signal,
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || j.error) throw new Error(j.error || `transcription HTTP ${resp.status}`);
  return (j.text as string) ?? "";
}

export interface VoiceActivityResult {
  is_speech: boolean;
  speech_probability: number;
}

export async function detectSpeech(wav: Blob, voice?: VoiceSettings, signal?: AbortSignal): Promise<VoiceActivityResult> {
  const url = new URL(`${BASE}/audio/vad`);
  if (voice?.serverVadProvider === "native") {
    url.searchParams.set("provider", "native");
    if (voice.serverVadModelPath.trim()) url.searchParams.set("model_path", voice.serverVadModelPath.trim());
  } else {
    url.searchParams.set("provider", "energy");
    url.searchParams.set("threshold", String(voice?.serverVadThreshold ?? 0.015));
  }

  const resp = await authFetch(url, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: wav,
    signal,
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || j.error) throw new Error(j.error?.message || j.error || `VAD HTTP ${resp.status}`);
  return {
    is_speech: Boolean(j.is_speech),
    speech_probability: Number(j.speech_probability ?? 0),
  };
}

export async function testVoiceTranscription(voice: VoiceSettings): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    return await transcribe(createSilentWav(), voice, ctrl.signal);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("transcription test timed out");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function testVoiceActivity(voice: VoiceSettings): Promise<VoiceActivityResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    return await detectSpeech(createSilentWav(), voice, ctrl.signal);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error("VAD test timed out");
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export type VoiceSetupTarget = "stt" | "tts" | "vad";

export async function checkVoiceSetup(voice: VoiceSettings, target: VoiceSetupTarget): Promise<string> {
  let body: Record<string, string | undefined>;
  if (target === "stt") {
    if (voice.provider === "parakeet") {
      body = { kind: "parakeet", command: voice.parakeetCommand.trim() };
    } else if (voice.provider === "whisper") {
      body = { kind: "whisper", model_path: voice.whisperModelPath.trim() };
    } else {
      throw new Error("Use Test transcription for remote STT providers");
    }
  } else if (target === "vad") {
    if (voice.serverVadProvider === "native") {
      body = { kind: "native-vad", model_path: voice.serverVadModelPath.trim() };
    } else {
      return `Energy VAD threshold: ${voice.serverVadThreshold}`;
    }
  } else if (voice.ttsProvider === "piper") {
    body = {
      kind: "piper",
      command: voice.piperCommand.trim(),
      model_path: voice.piperModelPath.trim(),
    };
  } else if (voice.ttsProvider === "openai") {
    body = {
      kind: "openai-tts",
      endpoint: voice.ttsOpenAiEndpoint.trim(),
      model: voice.ttsOpenAiModel.trim(),
    };
  } else if (voice.ttsProvider === "native") {
    body = {
      kind: "native-tts",
      model_path: voice.nativeTtsModelPath.trim(),
      config_path: voice.nativeTtsConfigPath.trim() || undefined,
    };
  } else {
    body = { kind: "tts-command", command: voice.ttsCommand.trim() };
  }

  const resp = await authFetch(`${BASE}/audio/setup/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok || j.error) throw new Error(j.error || `setup check HTTP ${resp.status}`);
  return (j.message as string) ?? "Setup check passed.";
}

export interface PiperPresetInstallResult {
  id: string;
  model_path: string;
  config_path: string;
  message: string;
}

export interface PiperPresetInstallProgress extends Partial<PiperPresetInstallResult> {
  phase?: "model" | "config";
  downloaded?: number;
  total?: number | null;
  done?: boolean;
  error?: string;
}

export async function installPiperPreset(
  preset: PiperPreset,
  onProgress?: (progress: PiperPresetInstallProgress) => void,
  signal?: AbortSignal,
): Promise<PiperPresetInstallResult> {
  const resp = await authFetch(`${BASE}/audio/piper/presets/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: preset.id,
      model_url: preset.modelUrl,
      config_url: preset.configUrl,
    }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j.error?.message || j.error || `Piper install HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: PiperPresetInstallResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const progress = JSON.parse(line.slice(5).trim()) as PiperPresetInstallProgress;
        if (progress.error) throw new Error(progress.error);
        onProgress?.(progress);
        if (progress.done && progress.id && progress.model_path && progress.config_path) {
          finalResult = progress as PiperPresetInstallResult;
        }
      } catch (e) {
        if (e instanceof Error) throw e;
      }
    }
  }
  if (!finalResult) throw new Error("Piper install did not complete");
  return finalResult;
}

export interface KokoroPresetInstallResult {
  id: string;
  voice: string;
  model_path: string;
  config_path: string;
  voice_path: string;
  message: string;
}

export interface KokoroPresetInstallProgress extends Partial<KokoroPresetInstallResult> {
  phase?: "model" | "config" | "voice";
  downloaded?: number;
  total?: number | null;
  done?: boolean;
  error?: string;
}

export async function installKokoroPreset(
  preset: KokoroPreset,
  onProgress?: (progress: KokoroPresetInstallProgress) => void,
  signal?: AbortSignal,
): Promise<KokoroPresetInstallResult> {
  const resp = await authFetch(`${BASE}/audio/kokoro/presets/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: preset.id,
      model_url: preset.modelUrl,
      config_url: preset.configUrl,
      voice_url: preset.voiceUrl,
      voice: preset.voice,
    }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j.error?.message || j.error || `Kokoro install HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: KokoroPresetInstallResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const progress = JSON.parse(line.slice(5).trim()) as KokoroPresetInstallProgress;
        if (progress.error) throw new Error(progress.error);
        onProgress?.(progress);
        if (progress.done && progress.id && progress.model_path && progress.config_path && progress.voice_path) {
          finalResult = progress as KokoroPresetInstallResult;
        }
      } catch (e) {
        if (e instanceof Error) throw e;
      }
    }
  }
  if (!finalResult) throw new Error("Kokoro install did not complete");
  return finalResult;
}

export interface VadPresetInstallResult {
  id: string;
  model_path: string;
  message: string;
}

export interface VadPresetInstallProgress extends Partial<VadPresetInstallResult> {
  phase?: "model";
  downloaded?: number;
  total?: number | null;
  done?: boolean;
  error?: string;
}

export async function installVadPreset(
  preset: VadPreset,
  onProgress?: (progress: VadPresetInstallProgress) => void,
  signal?: AbortSignal,
): Promise<VadPresetInstallResult> {
  const resp = await authFetch(`${BASE}/audio/vad/presets/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: preset.id,
      model_url: preset.modelUrl,
    }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j.error?.message || j.error || `VAD install HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: VadPresetInstallResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const progress = JSON.parse(line.slice(5).trim()) as VadPresetInstallProgress;
        if (progress.error) throw new Error(progress.error);
        onProgress?.(progress);
        if (progress.done && progress.id && progress.model_path) {
          finalResult = progress as VadPresetInstallResult;
        }
      } catch (e) {
        if (e instanceof Error) throw e;
      }
    }
  }
  if (!finalResult) throw new Error("VAD install did not complete");
  return finalResult;
}

export interface PiperExecutableInstallResult {
  executable_path: string;
  message: string;
}

export interface PiperExecutableInstallProgress extends Partial<PiperExecutableInstallResult> {
  phase?: "archive" | "extract";
  downloaded?: number;
  total?: number | null;
  done?: boolean;
  error?: string;
}

export async function installPiperExecutable(
  onProgress?: (progress: PiperExecutableInstallProgress) => void,
  signal?: AbortSignal,
): Promise<PiperExecutableInstallResult> {
  const resp = await authFetch(`${BASE}/audio/piper/executable/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j.error?.message || j.error || `Piper executable install HTTP ${resp.status}`);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResult: PiperExecutableInstallResult | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      try {
        const progress = JSON.parse(line.slice(5).trim()) as PiperExecutableInstallProgress;
        if (progress.error) throw new Error(progress.error);
        onProgress?.(progress);
        if (progress.done && progress.executable_path) {
          finalResult = {
            executable_path: progress.executable_path,
            message: progress.message ?? "Piper executable installed",
          };
        }
      } catch (e) {
        if (e instanceof Error) throw e;
      }
    }
  }
  if (!finalResult) throw new Error("Piper executable install did not complete");
  return finalResult;
}

export async function speakText(text: string, voice?: VoiceSettings): Promise<Blob> {
  const input = text.trim();
  if (!input) throw new Error("TTS input is required");
  if (!voice?.ttsEnabled) throw new Error("Text-to-speech is disabled");

  const url = new URL(`${BASE}/audio/speech`);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (voice.ttsProvider === "piper") {
    const command = voice.piperCommand.trim();
    const modelPath = voice.piperModelPath.trim();
    if (!command) throw new Error("Piper command is required");
    if (!modelPath) throw new Error("Piper model path is required");
    url.searchParams.set("provider", "piper");
    url.searchParams.set("command", command);
    url.searchParams.set("model_path", modelPath);
  } else if (voice.ttsProvider === "openai") {
    const endpoint = voice.ttsOpenAiEndpoint.trim();
    const model = voice.ttsOpenAiModel.trim();
    if (!endpoint) throw new Error("OpenAI-compatible TTS endpoint is required");
    if (!model) throw new Error("OpenAI-compatible TTS model is required");
    url.searchParams.set("provider", "openai");
    url.searchParams.set("endpoint", endpoint);
    url.searchParams.set("model", model);
    if (voice.ttsOpenAiApiKey.trim()) {
      headers.set("X-Milim-TTS-Api-Key", voice.ttsOpenAiApiKey.trim());
    }
  } else if (voice.ttsProvider === "native") {
    const modelPath = voice.nativeTtsModelPath.trim();
    if (!modelPath) throw new Error("Native TTS model path is required");
    url.searchParams.set("provider", "native");
    url.searchParams.set("engine", voice.nativeTtsEngine);
    url.searchParams.set("model_path", modelPath);
    if (voice.nativeTtsConfigPath.trim()) {
      url.searchParams.set("config_path", voice.nativeTtsConfigPath.trim());
    }
  } else {
    const command = voice.ttsCommand.trim();
    if (!command) throw new Error("TTS command is required");
    url.searchParams.set("provider", "command");
    url.searchParams.set("command", command);
  }
  if (voice.ttsVoice.trim()) url.searchParams.set("voice", voice.ttsVoice.trim());
  if (Number.isFinite(voice.ttsSpeed) && voice.ttsSpeed > 0) {
    url.searchParams.set("speed", String(voice.ttsSpeed));
  }

  const resp = await authFetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      input,
      voice: voice.ttsVoice.trim() || undefined,
      speed: voice.ttsSpeed,
    }),
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j.error || `TTS HTTP ${resp.status}`);
  }
  return await resp.blob();
}

// ----- Providers (LLM remotes and media credentials) -----

export type ProviderKind = "openai_compatible" | "anthropic" | "gemini" | "replicate" | "fal";

export interface ProviderInfo {
  id: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  enabled: boolean;
  has_key: boolean;
  models: string[];
  pricing?: Record<string, ProviderModelPricing>;
  model_reasoning?: Record<string, ModelReasoningMetadata>;
  error?: string | null;
}

export interface ProviderModelPricing {
  prompt?: string | null;
  completion?: string | null;
}

export interface ProviderDiscovery {
  name: string;
  kind: ProviderKind;
  base_url: string;
  configured: boolean;
  provider_id?: string | null;
  reachable: boolean;
  models: string[];
  error?: string | null;
}

/** One-click presets; base URLs include the provider version segment. */
export const PROVIDER_PRESETS: Array<{ name: string; kind: ProviderKind; base_url: string; needsKey: boolean }> = [
  { name: "OpenAI", kind: "openai_compatible", base_url: "https://api.openai.com/v1", needsKey: true },
  { name: "OpenRouter", kind: "openai_compatible", base_url: "https://openrouter.ai/api/v1", needsKey: true },
  { name: "Groq", kind: "openai_compatible", base_url: "https://api.groq.com/openai/v1", needsKey: true },
  { name: "Anthropic", kind: "anthropic", base_url: "https://api.anthropic.com/v1", needsKey: true },
  { name: "Gemini", kind: "gemini", base_url: "https://generativelanguage.googleapis.com/v1beta", needsKey: true },
  { name: "Replicate", kind: "replicate", base_url: "https://api.replicate.com/v1", needsKey: true },
  { name: "fal", kind: "fal", base_url: "https://queue.fal.run", needsKey: true },
  { name: "Ollama (local)", kind: "openai_compatible", base_url: "http://localhost:11434/v1", needsKey: false },
  { name: "LM Studio (local)", kind: "openai_compatible", base_url: "http://localhost:1234/v1", needsKey: false },
];

export async function listProviders(): Promise<ProviderInfo[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await authFetch(`${BASE}/providers`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    return (j.providers ?? []) as ProviderInfo[];
  } catch {
    return [];
  }
}

export async function discoverLocalProviders(): Promise<ProviderDiscovery[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3500);
    const r = await authFetch(`${BASE}/providers/discover`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    return (j.providers ?? []) as ProviderDiscovery[];
  } catch {
    return [];
  }
}

export async function saveProvider(p: {
  id?: string;
  name: string;
  kind: ProviderKind;
  base_url: string;
  api_key?: string;
  enabled: boolean;
}): Promise<ProviderInfo | null> {
  try {
    const r = await authFetch(`${BASE}/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    });
    return r.ok ? ((await r.json()) as ProviderInfo) : null;
  } catch {
    return null;
  }
}

export async function deleteProvider(id: string): Promise<boolean> {
  try {
    const r = await authFetch(`${BASE}/providers/${encodeURIComponent(id)}`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}

// ----- Media generation -----

export type MediaKind = "image" | "video";

export interface MediaGenerationRequest {
  provider_id: string;
  kind: MediaKind;
  model: string;
  prompt: string;
  input?: Record<string, unknown>;
}

export interface MediaModelInfo {
  id: string;
  name: string;
  description: string;
  output_modalities: string[];
  supported_parameters: string[];
  default_parameters?: Record<string, unknown> | null;
  pricing?: Record<string, unknown> | null;
}

export interface MediaModelListOptions {
  query?: string;
  refresh?: boolean;
}

export interface MediaSchemaControlOption {
  label: string;
  value: unknown;
}

export interface MediaSchemaControl {
  key: string;
  label: string;
  kind: "select" | "number" | string;
  path: string[];
  description?: string;
  options?: MediaSchemaControlOption[];
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  item_kind?: string;
  placeholder?: string;
}

export interface MediaModelSchema {
  model: string;
  provider_id: string;
  provider: string;
  supported_parameters: string[];
  controls: MediaSchemaControl[];
  raw?: unknown;
}

export interface MediaStatusRequest {
  provider_id: string;
  id: string;
  model?: string;
  response_url?: string;
  status_url?: string;
}

export interface MediaResultItem {
  url: string;
  kind: MediaKind | string;
  mime?: string | null;
}

export interface MediaGenerationResult {
  id: string;
  object: "media.generation";
  provider_id: string;
  provider: string;
  provider_kind: ProviderKind;
  kind: MediaKind | string;
  model: string;
  status: string;
  output?: unknown;
  media: MediaResultItem[];
  urls: Record<string, string>;
  privacy: {
    mode: PrivacyMode;
    redacted: boolean;
    detections: number;
    kinds: string;
  };
  raw?: unknown;
}

export function isOpenRouterProvider(provider: Pick<ProviderInfo, "kind" | "name" | "base_url">): boolean {
  return provider.kind === "openai_compatible" && (
    provider.name.trim().toLowerCase() === "openrouter" ||
    provider.base_url.trim().toLowerCase().includes("openrouter.ai/")
  );
}

export function supportsMediaMetadataProvider(provider: Pick<ProviderInfo, "kind" | "name" | "base_url">): boolean {
  return provider.kind === "replicate" ||
    provider.kind === "fal" ||
    provider.kind === "openai_compatible" && isOpenRouterProvider(provider);
}

export function mediaProviders(providers: ProviderInfo[]): ProviderInfo[] {
  return providers.filter((provider) => provider.enabled && supportsMediaMetadataProvider(provider));
}

export async function generateMedia(request: MediaGenerationRequest, signal?: AbortSignal): Promise<MediaGenerationResult> {
  const r = await authFetch(`${BASE}/media/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!r.ok) {
    throw new Error(await responseErrorMessage(r, `media generation HTTP ${r.status}`));
  }
  return (await r.json()) as MediaGenerationResult;
}

export async function listMediaModels(providerId: string, kind: MediaKind = "image", options: MediaModelListOptions = {}): Promise<MediaModelInfo[]> {
  const url = new URL(`${BASE}/media/models`);
  url.searchParams.set("provider_id", providerId);
  url.searchParams.set("kind", kind);
  if (options.query?.trim()) url.searchParams.set("q", options.query.trim());
  if (options.refresh) url.searchParams.set("refresh", "true");
  const r = await authFetch(url);
  if (!r.ok) {
    throw new Error(await responseErrorMessage(r, `media models HTTP ${r.status}`));
  }
  const j = await r.json();
  return (j.models ?? []) as MediaModelInfo[];
}

export async function getMediaModelSchema(providerId: string, model: string, options: { refresh?: boolean } = {}): Promise<MediaModelSchema> {
  const url = new URL(`${BASE}/media/model-schema`);
  url.searchParams.set("provider_id", providerId);
  url.searchParams.set("model", model);
  if (options.refresh) url.searchParams.set("refresh", "true");
  const r = await authFetch(url);
  if (!r.ok) {
    throw new Error(await responseErrorMessage(r, `media model schema HTTP ${r.status}`));
  }
  return (await r.json()) as MediaModelSchema;
}

export async function getMediaStatus(request: MediaStatusRequest): Promise<MediaGenerationResult> {
  const url = new URL(`${BASE}/media/status`);
  url.searchParams.set("provider_id", request.provider_id);
  url.searchParams.set("id", request.id);
  if (request.model) url.searchParams.set("model", request.model);
  if (request.response_url) url.searchParams.set("response_url", request.response_url);
  if (request.status_url) url.searchParams.set("status_url", request.status_url);
  const r = await authFetch(url);
  if (!r.ok) {
    throw new Error(await responseErrorMessage(r, `media status HTTP ${r.status}`));
  }
  return (await r.json()) as MediaGenerationResult;
}

/**
 * Point the host filesystem/shell tools at `folder` (the working folder). Pass
 * "" to clear. The agent's read_file/write_file/edit_file/list_dir/shell tools
 * operate within this folder; until it's set they refuse to run.
 */
export async function setWorkspace(folder: string): Promise<boolean> {
  try {
    const r = await authFetch(`${BASE}/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

export type WorkspaceGitState = "no_folder" | "not_git" | "ready" | "error";

export interface WorkspaceGitStatus {
  state: WorkspaceGitState;
  folder: string | null;
  is_repo: boolean;
  root: string | null;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  remote: string | null;
  ahead: number;
  behind: number;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  insertions: number;
  deletions: number;
  has_changes: boolean;
  changed_file_count: number;
  changed_files: WorkspaceGitFileChange[];
  branches: WorkspaceGitBranch[];
  message: string | null;
}

export interface WorkspaceGitFileChange {
  status: string;
  path: string;
}

export interface WorkspaceGitBranch {
  name: string;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
}

export type WorkspaceGitAction = "diff" | "fetch" | "pull" | "push" | "publish" | "commit" | "commit_push" | "checkout_branch" | "create_branch" | "checkpoint" | "restore_checkpoint";

export interface WorkspaceGitActionResult {
  ok: boolean;
  action: WorkspaceGitAction;
  command: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  message: string;
  truncated: boolean;
  checkpoint?: string;
  root?: string;
  head?: string;
}

export async function getWorkspaceGitStatus(): Promise<WorkspaceGitStatus | null> {
  try {
    const r = await authFetch(`${BASE}/workspace/git`);
    return r.ok ? ((await r.json()) as WorkspaceGitStatus) : null;
  } catch {
    return null;
  }
}

export async function runWorkspaceGitAction(
  action: WorkspaceGitAction,
  options: { message?: string; checkpoint?: string; stage_all?: boolean; staged_only?: boolean; branch?: string } = {},
): Promise<WorkspaceGitActionResult> {
  const r = await authFetch(`${BASE}/workspace/git/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...options }),
  });
  if (r.status === 404) throw new Error("Restart the desktop backend to enable Git command buttons.");
  if (!r.ok) throw new Error(await responseErrorMessage(r, `git action HTTP ${r.status}`));
  return (await r.json()) as WorkspaceGitActionResult;
}

/**
 * Enable/disable the computer-use layer (screen capture + mouse/keyboard).
 * Off by default; the agent's screenshot/mouse/keyboard tools refuse to run
 * until this is enabled.
 */
export async function setComputerUse(enabled: boolean): Promise<boolean> {
  try {
    const r = await authFetch(`${BASE}/computer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Outbound privacy gate for remote providers. `redact` replaces PII with
 *  reversible placeholders; `block` refuses a remote send that contains PII.
 *  Local models are never scanned. */
export type PrivacyMode = "off" | "redact" | "block";

export interface PrivacyDetection {
  kind: string;
  value: string;
  start: number;
  end: number;
}

export interface PrivacyScanResult {
  clean: boolean;
  detections: PrivacyDetection[];
  redacted: string;
  map: Record<string, string>;
}

/** Set the outbound privacy gate mode on the server (applies to remote sends). */
export async function setPrivacyMode(mode: PrivacyMode): Promise<boolean> {
  try {
    const r = await authFetch(`${BASE}/privacy/mode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

async function responseErrorMessage(resp: Response, fallback: string): Promise<string> {
  try {
    const json = await resp.json();
    return String(json.error?.message ?? json.error ?? fallback);
  } catch {
    return fallback;
  }
}

export async function scanPrivacyText(text: string): Promise<PrivacyScanResult> {
  const r = await authFetch(`${BASE}/privacy/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!r.ok) {
    throw new Error(await responseErrorMessage(r, `privacy scan HTTP ${r.status}`));
  }
  return (await r.json()) as PrivacyScanResult;
}

// ----- Memory / RAG -----

export type MemoryScopeKind = "thread" | "project" | "global";

export interface MemoryScopeRef {
  kind: MemoryScopeKind;
  locator: string;
}

export interface MemoryScope {
  id: string;
  kind: MemoryScopeKind;
  label: string;
  locator: string;
  locator_hash: string;
  created_at: string;
  updated_at: string;
}

export interface MemoryNode {
  id: string;
  scope_id: string;
  scope_kind: MemoryScopeKind;
  scope_label: string;
  kind: string;
  title: string;
  body: string;
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
  archived_at?: string | null;
}

export interface MemoryNotice {
  id: string;
  node_id: string;
  scope_kind: MemoryScopeKind;
  scope_label: string;
  summary: string;
  created_at: string;
}

export interface MemoryGraphHit {
  node: MemoryNode;
  score: number;
}

export interface RegisterMemoryInput {
  scope: {
    kind: MemoryScopeKind;
    label: string;
    locator: string;
  };
  node: {
    kind: string;
    title: string;
    body: string;
    confidence?: number;
    source?: string;
  };
  event?: {
    thread_id?: string;
    message_id?: string;
    summary?: string;
  };
  model?: string;
}

export interface MemoryRegistration {
  scope: MemoryScope;
  node: MemoryNode;
  notice: MemoryNotice;
}

export async function registerGraphMemory(input: RegisterMemoryInput): Promise<MemoryRegistration | null> {
  try {
    const memoryModel = input.model && isUsableChatModel(input.model) ? input.model : "default";
    const r = await authFetch(`${BASE}/memory/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: memoryModel,
        scope: input.scope,
        node: {
          confidence: 1,
          source: "user",
          ...input.node,
        },
        event: input.event ?? {},
      }),
    });
    if (!r.ok) return null;
    return (await r.json()) as MemoryRegistration;
  } catch {
    return null;
  }
}

export async function listMemoryNodes(options: {
  scope?: MemoryScopeRef;
  includeArchived?: boolean;
  limit?: number;
} = {}): Promise<MemoryNode[]> {
  try {
    const params = new URLSearchParams();
    if (options.scope) {
      params.set("scope_kind", options.scope.kind);
      params.set("scope_locator", options.scope.locator);
    }
    if (options.includeArchived) params.set("include_archived", "true");
    if (options.limit) params.set("limit", String(options.limit));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const r = await authFetch(`${BASE}/memory/nodes${suffix}`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.nodes ?? []) as MemoryNode[];
  } catch {
    return [];
  }
}

export async function searchGraphMemory(
  query: string,
  scopes: MemoryScopeRef[],
  topK = 5,
  model?: string,
  includeArchived = false,
): Promise<MemoryGraphHit[]> {
  try {
    const memoryModel = model && isUsableChatModel(model) ? model : "default";
    const r = await authFetch(`${BASE}/memory/graph/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: memoryModel,
        query,
        scopes,
        top_k: topK,
        include_archived: includeArchived,
      }),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.hits ?? []) as MemoryGraphHit[];
  } catch {
    return [];
  }
}

export async function updateMemoryNode(
  id: string,
  update: Partial<Pick<MemoryNode, "kind" | "title" | "body" | "confidence" | "source">>,
  model?: string,
): Promise<MemoryNode | null> {
  try {
    const memoryModel = model && isUsableChatModel(model) ? model : "default";
    const r = await authFetch(`${BASE}/memory/nodes/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: memoryModel, ...update }),
    });
    return r.ok ? ((await r.json()) as MemoryNode) : null;
  } catch {
    return null;
  }
}

export async function deleteMemoryNode(id: string): Promise<boolean> {
  try {
    const r = await authFetch(`${BASE}/memory/nodes/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) return false;
    const j = await r.json();
    return Boolean(j.deleted);
  } catch {
    return false;
  }
}

export async function archiveMemoryNode(id: string): Promise<boolean> {
  try {
    const r = await authFetch(`${BASE}/memory/nodes/${encodeURIComponent(id)}/archive`, { method: "POST" });
    if (!r.ok) return false;
    const j = await r.json();
    return Boolean(j.archived);
  } catch {
    return false;
  }
}

// ----- Schedules -----

export interface ScheduleInfo {
  id: string;
  name: string;
  cron: string;
  agent_id?: string | null;
  prompt: string;
  attachments?: ChatAttachment[];
  enabled: boolean;
  last_run?: number | null;
}

export interface ScheduleRunEvent {
  id: string;
  schedule_id: string;
  schedule_name: string;
  prompt: string;
  response: string;
  model: string;
  ran_at: number;
}

export async function listSchedules(): Promise<ScheduleInfo[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await authFetch(`${BASE}/schedules`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.schedules ?? []) as ScheduleInfo[];
  } catch {
    return [];
  }
}

export async function pollScheduleRunEvents(): Promise<ScheduleRunEvent[]> {
  try {
    const r = await authFetch(`${BASE}/schedules/events`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.events ?? []) as ScheduleRunEvent[];
  } catch {
    return [];
  }
}

export async function createSchedule(s: {
  name: string;
  cron: string;
  agent_id?: string | null;
  prompt: string;
  attachments?: ChatAttachment[];
}): Promise<ScheduleInfo | null> {
  try {
    const r = await authFetch(`${BASE}/schedules`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    });
    return r.ok ? ((await r.json()) as ScheduleInfo) : null;
  } catch {
    return null;
  }
}

export async function updateSchedule(s: ScheduleInfo): Promise<ScheduleInfo | null> {
  try {
    const r = await authFetch(`${BASE}/schedules/${encodeURIComponent(s.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    });
    return r.ok ? ((await r.json()) as ScheduleInfo) : null;
  } catch {
    return null;
  }
}

export async function deleteSchedule(id: string): Promise<boolean> {
  try {
    const r = await authFetch(`${BASE}/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}

// ----- MCP client (external MCP servers whose tools we consume) -----

export interface McpServerInfo {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  connected: boolean;
  tool_count: number;
  capabilities?: { tools: boolean; resources: boolean; prompts: boolean };
  error: string | null;
}

/** Suggested MCP servers (command + args) for quick setup. */
export const MCP_PRESETS: Array<{ name: string; command: string; args: string[]; note?: string }> = [
  { name: "Filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], note: "Replace '.' with a folder to expose." },
  { name: "Fetch", command: "npx", args: ["-y", "@modelcontextprotocol/server-fetch"], note: "Web fetch as an MCP tool." },
  { name: "Memory", command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], note: "Knowledge-graph memory." },
  { name: "Sequential Thinking", command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] },
];

export async function listMcpServers(): Promise<McpServerInfo[]> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await authFetch(`${BASE}/mcp/servers`, { signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json();
    return (j.servers ?? []) as McpServerInfo[];
  } catch {
    return [];
  }
}

/** Add/update an MCP server. Connects immediately (may take a while as the
 *  server's package is fetched), so this call is intentionally untimed. */
export async function saveMcpServer(s: {
  id?: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}): Promise<McpServerInfo | null> {
  try {
    const r = await authFetch(`${BASE}/mcp/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(s),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j.server ?? null) as McpServerInfo | null;
  } catch {
    return null;
  }
}

export async function deleteMcpServer(id: string): Promise<boolean> {
  try {
    const r = await authFetch(`${BASE}/mcp/servers/${encodeURIComponent(id)}`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}

// ----- Skills -----

export interface SkillInfo {
  id: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  source_kind: string;
  source_url?: string | null;
  updated_at?: string;
}

export async function listSkills(): Promise<SkillInfo[]> {
  try {
    const r = await authFetch(`${BASE}/skills`);
    if (!r.ok) return [];
    const j = await r.json();
    return (j.skills ?? []) as SkillInfo[];
  } catch {
    return [];
  }
}

export async function createSkill(input: {
  skill_md?: string;
  skill_url?: string;
  name?: string;
  description?: string;
  instructions?: string;
  enabled?: boolean;
}): Promise<SkillInfo | null> {
  try {
    const r = await authFetch(`${BASE}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, ...input }),
    });
    if (!r.ok) throw new Error(await responseErrorMessage(r, `skill create HTTP ${r.status}`));
    return (await r.json()) as SkillInfo;
  } catch {
    return null;
  }
}

export async function updateSkill(skill: SkillInfo): Promise<SkillInfo | null> {
  try {
    const r = await authFetch(`${BASE}/skills/${encodeURIComponent(skill.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(skill),
    });
    return r.ok ? ((await r.json()) as SkillInfo) : null;
  } catch {
    return null;
  }
}

export async function deleteSkill(id: string): Promise<boolean> {
  try {
    const r = await authFetch(`${BASE}/skills/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!r.ok) return false;
    const j = await r.json();
    return Boolean(j.deleted);
  } catch {
    return false;
  }
}

export async function selectSkills(query: string, limit = 3): Promise<SkillInfo[]> {
  try {
    if (!query.trim()) return [];
    const r = await authFetch(`${BASE}/skills/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.skills ?? []) as SkillInfo[];
  } catch {
    return [];
  }
}
