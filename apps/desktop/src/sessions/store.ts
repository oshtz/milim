import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ChatArtifact, ChatAttachment, ChatMessage, ChatStreamPart, ChildThreadInfo, ChildThreadStatus, MemoryNotice, PreviewAppState, PrivacyMode, ReasoningEffort, ResponseMetrics, RunTrace, SavedArtifactFile, ThreadEvent, ToolApprovalMode } from "../api";
import { extractArtifactsFromMessage, normalizeArtifactDisposition } from "../lib/artifacts.js";
import { DEFAULT_GOAL_SETTINGS, normalizeGoalSettings, type GoalSettings } from "../lib/goals.js";
import { recordPerfMeasure, startPerfMeasure } from "../lib/perf.js";
import { deriveThreadTitle, NEW_CHAT_TITLE } from "../lib/threadTitles.js";
import { userStateStorage } from "../persistence/userStateStorage.js";

export interface ThreadSettings {
  model: string;
  instructions: string;
  folder: string;
  sandbox: boolean;
  computerUse: boolean;
  memory: boolean;
  activeAgentId: string | null;
  /** Outbound privacy gate for remote providers (off | redact | block). */
  privacy: PrivacyMode;
  /** Tool execution gate for shell/computer/sandbox actions. */
  toolApproval: ToolApprovalMode;
  /** Read-only planning mode for implementation planning before execution. */
  planMode: boolean;
  goal: GoalSettings;
}

type ThreadSettingsPatch = Partial<Omit<ThreadSettings, "goal">> & {
  goal?: Partial<GoalSettings>;
  reasoningEffort?: ReasoningEffort;
  reasoningEffortByModel?: Record<string, ReasoningEffort>;
};

export interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
  artifactPanelOpen?: boolean;
  sidePanelMode?: SessionSidePanelMode;
  artifactPanelTab?: SessionArtifactPanelTab;
  previewRuntime?: SessionPreviewRuntime;
  settings?: ThreadSettings;
  accountRuntime?: {
    codexThreadId?: string;
    claudeSessionId?: string;
  };
  parentId?: string;
  worker?: {
    status: ChildThreadStatus;
    model: string;
    agentId?: string;
    summary?: string;
    error?: string;
  };
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export type SessionSidePanelMode = "artifact" | "browser" | "git";
export type SessionArtifactPanelTab = "preview" | "code";

export interface SessionPreviewRuntime {
  status: PreviewAppState | string;
  cwd?: string;
  url?: string;
  pid?: number;
  command?: string;
  message?: string;
  updatedAt?: number;
}

export type ArchiveRetentionDays = 7 | 14 | 30;

export interface Project {
  id: string;
  name: string;
  folder: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
}

export const SIDEBAR_PINNED_SECTION_ID = "pinned";
export const SIDEBAR_CHATS_SECTION_ID = "chats";
export const SIDEBAR_PROJECT_SECTION_PREFIX = "project:";
export const DEFAULT_ARCHIVE_RETENTION_DAYS: ArchiveRetentionDays = 30;
export const DAY_MS = 24 * 60 * 60 * 1000;

export interface SessionSidebarState {
  collapsedSectionIds: string[];
  pinnedSessionIds: string[];
  pinnedSectionIds: string[];
  sessionOrder: string[];
  sectionOrder: string[];
  projectFolders: string[];
}

export interface QueuedMessage {
  id: string;
  content: string;
  attachments?: ChatAttachment[];
  createdAt: number;
}

export const DEFAULT_THREAD_SETTINGS: ThreadSettings = {
  model: "",
  instructions: "",
  folder: "",
  sandbox: false,
  computerUse: false,
  memory: true,
  activeAgentId: null,
  privacy: "off",
  toolApproval: "guarded",
  planMode: false,
  goal: DEFAULT_GOAL_SETTINGS,
};

const DEFAULT_SIDEBAR_STATE: SessionSidebarState = {
  collapsedSectionIds: [],
  pinnedSessionIds: [],
  pinnedSectionIds: [],
  sessionOrder: [],
  sectionOrder: [],
  projectFolders: [],
};

function uid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return "s-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

function runtimeUuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (char) =>
      (Number(char) ^ (Math.floor(Math.random() * 16) >> (Number(char) / 4))).toString(16),
    );
  }
}

function normalizeAccountRuntime(value: unknown): Session["accountRuntime"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const codexThreadId = typeof raw.codexThreadId === "string" && raw.codexThreadId.trim() ? raw.codexThreadId.trim() : undefined;
  const claudeSessionId = typeof raw.claudeSessionId === "string" && raw.claudeSessionId.trim() ? raw.claudeSessionId.trim() : undefined;
  return codexThreadId || claudeSessionId ? { codexThreadId, claudeSessionId } : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePreviewRuntime(value: unknown): SessionPreviewRuntime | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const status = stringValue(raw.status);
  if (!status) return undefined;
  const pid = typeof raw.pid === "number" && Number.isFinite(raw.pid) ? raw.pid : undefined;
  return {
    status,
    cwd: stringValue(raw.cwd),
    url: stringValue(raw.url),
    pid,
    command: stringValue(raw.command),
    message: stringValue(raw.message),
    updatedAt: timestamp(raw.updatedAt),
  };
}

function samePreviewRuntime(a?: SessionPreviewRuntime, b?: SessionPreviewRuntime): boolean {
  return (
    (a?.status ?? "") === (b?.status ?? "") &&
    (a?.cwd ?? "") === (b?.cwd ?? "") &&
    (a?.url ?? "") === (b?.url ?? "") &&
    (a?.pid ?? null) === (b?.pid ?? null) &&
    (a?.command ?? "") === (b?.command ?? "") &&
    (a?.message ?? "") === (b?.message ?? "")
  );
}

function normalizeSidePanelMode(value: unknown, legacyOpen?: boolean): SessionSidePanelMode | undefined {
  if (value === "artifact" || value === "browser" || value === "git") return value;
  return legacyOpen === true ? "artifact" : undefined;
}

function normalizeArtifactPanelTab(value: unknown): SessionArtifactPanelTab | undefined {
  return value === "code" ? "code" : undefined;
}

function normalizeSettings(settings?: ThreadSettingsPatch, options: { pauseRunningGoal?: boolean } = {}): ThreadSettings {
  const { reasoningEffort: _legacyEffort, reasoningEffortByModel: _legacyEffortByModel, ...settingsWithoutLegacyReasoning } = settings ?? {};
  const next: ThreadSettings = {
    ...DEFAULT_THREAD_SETTINGS,
    ...settingsWithoutLegacyReasoning,
    goal: normalizeGoalSettings(settings?.goal ?? DEFAULT_GOAL_SETTINGS, { pauseRunning: options.pauseRunningGoal }),
  };
  if (next.model.trim().toLowerCase() === "mock-echo") {
    next.model = "";
  }
  if (next.toolApproval !== "review" && next.toolApproval !== "guarded" && next.toolApproval !== "open") {
    next.toolApproval = DEFAULT_THREAD_SETTINGS.toolApproval;
  }
  if (typeof next.planMode !== "boolean") {
    next.planMode = DEFAULT_THREAD_SETTINGS.planMode;
  }
  return next;
}

function normalizeProjectFolder(folder?: string): string {
  return (folder ?? "").trim();
}

function folderLabel(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() || folder || "Project";
}

export function projectSectionId(folder?: string): string {
  const normalized = normalizeProjectFolder(folder);
  return normalized ? `${SIDEBAR_PROJECT_SECTION_PREFIX}${normalized}` : SIDEBAR_CHATS_SECTION_ID;
}

export function isSidebarProjectSectionId(id: string): boolean {
  return id.startsWith(SIDEBAR_PROJECT_SECTION_PREFIX);
}

export function folderFromProjectSectionId(id: string): string | null {
  if (id === SIDEBAR_CHATS_SECTION_ID) return "";
  if (isSidebarProjectSectionId(id)) return id.slice(SIDEBAR_PROJECT_SECTION_PREFIX.length);
  return null;
}

function uniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function orderedUnique(existing: string[], fallback: string[]): string[] {
  return uniqueStrings([...existing, ...fallback]);
}

type SidebarInsertPosition = "before" | "after" | "inside";

function moveInOrder(order: string[], id: string, targetId?: string | null, position: SidebarInsertPosition = "before"): string[] {
  const next = order.filter((item) => item !== id);
  if (!targetId) return position === "after" ? [...next, id] : [id, ...next];
  const targetIndex = next.indexOf(targetId);
  if (targetIndex === -1) return position === "after" ? [...next, id] : [id, ...next];
  next.splice(position === "after" ? targetIndex + 1 : targetIndex, 0, id);
  return next;
}

function folderListFromSessions(sessions: Session[]): string[] {
  return uniqueStrings(sessions.filter((session) => !session.parentId).map((session) => session.settings?.folder ?? ""));
}

function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeArchiveRetentionDays(value: unknown): ArchiveRetentionDays {
  return value === 7 || value === 14 || value === 30 ? value : DEFAULT_ARCHIVE_RETENTION_DAYS;
}

function projectFromFolder(folder: string, existing?: Partial<Project>, now = Date.now()): Project {
  const normalized = normalizeProjectFolder(folder);
  const createdAt = timestamp(existing?.createdAt) ?? now;
  return {
    id: projectSectionId(normalized),
    name: typeof existing?.name === "string" && existing.name.trim() ? existing.name.trim() : folderLabel(normalized),
    folder: normalized,
    createdAt,
    updatedAt: timestamp(existing?.updatedAt) ?? createdAt,
    archivedAt: timestamp(existing?.archivedAt),
  };
}

function normalizeProjects(value: unknown, sessions: Session[], legacyFolders: string[]): Project[] {
  const now = Date.now();
  const rawProjects = Array.isArray(value) ? value : [];
  const byFolder = new Map<string, Partial<Project>>();
  for (const raw of rawProjects) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const project = raw as Partial<Project>;
    const folder = normalizeProjectFolder(project.folder);
    if (folder) byFolder.set(folder, project);
  }
  return uniqueStrings([...byFolder.keys(), ...legacyFolders, ...folderListFromSessions(sessions)])
    .map((folder) => projectFromFolder(folder, byFolder.get(folder), now));
}

function upsertProject(projects: Project[], folder: string, now = Date.now()): Project[] {
  const normalized = normalizeProjectFolder(folder);
  if (!normalized) return projects;
  const id = projectSectionId(normalized);
  if (projects.some((project) => project.id === id)) {
    return projects.map((project) => project.id === id ? { ...project, folder: normalized, archivedAt: undefined, updatedAt: now } : project);
  }
  return [projectFromFolder(normalized, { createdAt: now, updatedAt: now }), ...projects];
}

function archivedProjectFolders(projects: Project[]): Set<string> {
  return new Set(projects.filter((project) => project.archivedAt).map((project) => project.folder));
}

function visibleSessions(sessions: Session[], projects: Project[]): Session[] {
  const archivedFolders = archivedProjectFolders(projects);
  return sessions.filter((session) => {
    if (session.archivedAt) return false;
    const folder = normalizeProjectFolder(session.settings?.folder);
    return !folder || !archivedFolders.has(folder);
  });
}

function ensureVisibleActive(activeId: string, sessions: Session[], projects: Project[]): { activeId: string; sessions: Session[] } {
  const visible = visibleSessions(sessions, projects);
  if (visible.some((session) => session.id === activeId)) return { activeId, sessions };
  const nextActive = visible[0];
  if (nextActive) return { activeId: nextActive.id, sessions };
  const fresh = freshSession();
  return { activeId: fresh.id, sessions: [fresh, ...sessions] };
}

function sessionIdsInFolder(sessions: Session[], folder: string): Set<string> {
  const normalized = normalizeProjectFolder(folder);
  return new Set(sessions.filter((session) => normalizeProjectFolder(session.settings?.folder) === normalized).map((session) => session.id));
}

function sectionIdsForState(sidebar: SessionSidebarState, sessions: Session[]): string[] {
  const folders = orderedUnique(sidebar.projectFolders, folderListFromSessions(sessions));
  return [SIDEBAR_PINNED_SECTION_ID, SIDEBAR_CHATS_SECTION_ID, ...folders.map((folder) => projectSectionId(folder))];
}

function projectSectionIdsForState(sidebar: SessionSidebarState, sessions: Session[]): string[] {
  const folders = orderedUnique(sidebar.projectFolders, folderListFromSessions(sessions));
  return folders.map((folder) => projectSectionId(folder));
}

function normalizeSidebarState(state: Partial<SessionSidebarState> | undefined, sessions: Session[]): SessionSidebarState {
  const sessionIds = new Set(sessions.map((session) => session.id));
  const baseProjectFolders = orderedUnique(uniqueStrings(state?.projectFolders), folderListFromSessions(sessions));
  const base: SessionSidebarState = {
    collapsedSectionIds: uniqueStrings(state?.collapsedSectionIds),
    pinnedSessionIds: uniqueStrings(state?.pinnedSessionIds).filter((id) => sessionIds.has(id)),
    pinnedSectionIds: uniqueStrings(state?.pinnedSectionIds),
    sessionOrder: orderedUnique(uniqueStrings(state?.sessionOrder).filter((id) => sessionIds.has(id)), sessions.map((session) => session.id)),
    sectionOrder: uniqueStrings(state?.sectionOrder),
    projectFolders: baseProjectFolders,
  };
  const validSections = new Set(sectionIdsForState(base, sessions));
  const projectSections = new Set(projectSectionIdsForState(base, sessions));
  return {
    collapsedSectionIds: base.collapsedSectionIds.filter((id) => validSections.has(id)),
    pinnedSessionIds: base.pinnedSessionIds,
    pinnedSectionIds: base.pinnedSectionIds.filter((id) => projectSections.has(id)),
    sessionOrder: base.sessionOrder,
    sectionOrder: orderedUnique(base.sectionOrder.filter((id) => projectSections.has(id)), Array.from(projectSections)),
    projectFolders: base.projectFolders,
  };
}

function freshSession(settings?: ThreadSettingsPatch): Session {
  const t = Date.now();
  const normalizedSettings = normalizeSettings(settings);
  return {
    id: uid(),
    title: "New chat",
    messages: [],
    settings: { ...normalizedSettings, goal: DEFAULT_GOAL_SETTINGS },
    createdAt: t,
    updatedAt: t,
  };
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  try {
    return JSON.parse(JSON.stringify(messages)) as ChatMessage[];
  } catch {
    return messages.map((message) => ({ ...message }));
  }
}

function branchTitle(title: string): string {
  const base = title.trim() || NEW_CHAT_TITLE;
  return base === NEW_CHAT_TITLE ? "Chat branch" : `${base} branch`;
}

function importedTitle(title: unknown): string {
  return typeof title === "string" && title.trim() ? title.trim() : "Imported chat";
}

function importedMessages(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  const out: ChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Partial<ChatMessage>;
    if (typeof raw.role !== "string" || typeof raw.content !== "string") continue;
    out.push(normalizeMessageArtifacts({ ...(JSON.parse(JSON.stringify(raw)) as ChatMessage), role: raw.role, content: raw.content }));
  }
  return out;
}

function normalizeMessageArtifacts(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant") return message;
  const artifacts = mergeArtifactState(extractArtifactsFromMessage(message.content, message.run), message.artifacts);
  return { ...message, artifacts: artifacts.length ? artifacts : undefined };
}

function mergeArtifactState(artifacts: ChatArtifact[], previous?: ChatArtifact[]): ChatArtifact[] {
  if (!previous?.length) return artifacts.map(normalizeArtifactDisposition);
  const savedById = new Map(previous.filter((artifact) => artifact.saved).map((artifact) => [artifact.id, artifact.saved]));
  return artifacts.map((artifact) => {
    const saved = savedById.get(artifact.id);
    return normalizeArtifactDisposition(saved ? { ...artifact, saved } : artifact);
  });
}

type ChatStreamEventPart = Extract<ChatStreamPart, { kind: "event" }>;
export type BufferedStreamChunk = { kind: "text" | "thinking"; content: string };

function appendTextStreamPart(parts: ChatStreamPart[] | undefined, token: string): ChatStreamPart[] {
  const next = parts ? parts.slice() : [];
  const last = next[next.length - 1];
  if (last?.kind === "text") {
    next[next.length - 1] = { ...last, content: last.content + token };
  } else {
    next.push({ kind: "text", content: token });
  }
  return next;
}

function appendThinkingStreamPart(parts: ChatStreamPart[] | undefined, token: string): ChatStreamPart[] {
  const next = parts ? parts.slice() : [];
  const last = next[next.length - 1];
  if (last?.kind === "thinking") {
    next[next.length - 1] = { ...last, content: last.content + token };
  } else {
    next.push({ kind: "thinking", content: token });
  }
  return next;
}

function appendEventStreamPart(parts: ChatStreamPart[] | undefined, part: ChatStreamEventPart): ChatStreamPart[] {
  return [...(parts ?? []), part];
}

function completeEventStreamPart(parts: ChatStreamPart[] | undefined, name: string, part: ChatStreamEventPart, callId?: string): ChatStreamPart[] {
  const next = parts ? parts.slice() : [];
  if (callId) {
    for (let i = next.length - 1; i >= 0; i -= 1) {
      const current = next[i];
      if (current.kind === "event" && current.eventType === "tool" && current.status === "running" && current.callId === callId) {
        next[i] = part;
        return next;
      }
    }
  }
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const current = next[i];
    if (current.kind === "event" && current.eventType === "tool" && current.status === "running" && current.name === name) {
      next[i] = part;
      return next;
    }
  }
  next.push(part);
  return next;
}

function appendStreamChunksToMessages(messages: ChatMessage[], chunks: BufferedStreamChunk[]): ChatMessage[] {
  const cleanChunks = chunks.filter((chunk) => chunk.content.length > 0);
  if (cleanChunks.length === 0) return messages;
  const next = messages.slice();
  const last = next[next.length - 1];
  if (!last) return messages;

  let content = last.content;
  let streamParts = last.streamParts;
  for (const chunk of cleanChunks) {
    if (chunk.kind === "text") {
      content += chunk.content;
      streamParts = appendTextStreamPart(streamParts, chunk.content);
    } else {
      streamParts = appendThinkingStreamPart(streamParts, chunk.content);
    }
  }

  next[next.length - 1] = normalizeMessageArtifacts({
    ...last,
    content,
    streamParts,
  });
  return next;
}

function normalizeSessionArtifacts(session: Session): Session {
  const archivedAt = timestamp(session.archivedAt);
  const messages = Array.isArray(session.messages) ? session.messages : [];
  return {
    ...session,
    archivedAt,
    artifactPanelOpen: session.artifactPanelOpen === true ? true : undefined,
    sidePanelMode: normalizeSidePanelMode(session.sidePanelMode, session.artifactPanelOpen),
    artifactPanelTab: normalizeArtifactPanelTab(session.artifactPanelTab),
    previewRuntime: normalizePreviewRuntime(session.previewRuntime),
    accountRuntime: normalizeAccountRuntime(session.accountRuntime),
    settings: normalizeSettings(session.settings, { pauseRunningGoal: true }),
    messages: messages.map(normalizeMessageArtifacts),
  };
}

function sessionsForPersistence(sessions: Session[]): Session[] {
  return sessions;
}

function normalizeQueuedMessagesBySession(value: unknown, sessions: Session[]): Record<string, QueuedMessage[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const sessionIds = new Set(sessions.map((session) => session.id));
  const next: Record<string, QueuedMessage[]> = {};
  for (const [sessionId, rawItems] of Object.entries(value as Record<string, unknown>)) {
    if (!sessionIds.has(sessionId) || !Array.isArray(rawItems)) continue;
    const items = rawItems.flatMap((item): QueuedMessage[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const queued = item as Partial<QueuedMessage>;
      const id = typeof queued.id === "string" && queued.id.trim() ? queued.id : uid();
      const content = typeof queued.content === "string" ? queued.content : "";
      const attachments = Array.isArray(queued.attachments) ? queued.attachments : undefined;
      const createdAt = typeof queued.createdAt === "number" && Number.isFinite(queued.createdAt) ? queued.createdAt : Date.now();
      if (!content.trim() && !attachments?.length) return [];
      return [{ id, content, attachments, createdAt }];
    });
    if (items.length) next[sessionId] = items;
  }
  return next;
}

function withoutQueuedSessions(queue: Record<string, QueuedMessage[]>, removed: Set<string>): Record<string, QueuedMessage[]> {
  const next = { ...queue };
  for (const id of removed) delete next[id];
  return next;
}

function threadTime(value?: string | null): number {
  if (!value) return Date.now();
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function workerFromThread(thread: ChildThreadInfo): Session["worker"] {
  return {
    status: thread.status,
    model: thread.model,
    agentId: thread.agent_id ?? undefined,
    summary: thread.summary ?? undefined,
    error: thread.error ?? undefined,
  };
}

function eventPayload(event: ThreadEvent): Record<string, unknown> {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
}

function eventText(event: ThreadEvent, key: string): string {
  const value = eventPayload(event)[key];
  return typeof value === "string" ? value : "";
}

function childToolEventLabel(name: string, done: boolean): string {
  return done ? `Used ${name}` : `Using ${name}`;
}

function childToolEventDetail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? (trimmed.length > 110 ? trimmed.slice(0, 109) + "..." : trimmed) : undefined;
}

function childStreamFromEvents(events?: ThreadEvent[]): { content: string; streamParts?: ChatStreamPart[] } {
  let content = "";
  let streamParts: ChatStreamPart[] = [];
  for (const event of events ?? []) {
    if (event.kind === "token") {
      const text = eventText(event, "text");
      content += text;
      streamParts = appendTextStreamPart(streamParts, text);
    } else if (event.kind === "reasoning") {
      streamParts = appendThinkingStreamPart(streamParts, eventText(event, "text"));
    } else if (event.kind === "tool_call") {
      const name = eventText(event, "name") || "tool";
      const callId = eventText(event, "call_id") || undefined;
      streamParts = appendEventStreamPart(streamParts, {
        kind: "event",
        eventType: "tool",
        label: childToolEventLabel(name, false),
        detail: childToolEventDetail(eventText(event, "arguments")),
        name,
        callId,
        icon: "tool",
        status: "running",
      });
    } else if (event.kind === "tool_result") {
      const payload = eventPayload(event);
      const name = eventText(event, "name") || "tool";
      const callId = eventText(event, "call_id") || undefined;
      const result = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result) ? payload.result as Record<string, unknown> : {};
      const error = typeof result.error === "string" ? result.error : "";
      streamParts = completeEventStreamPart(streamParts, name, {
        kind: "event",
        eventType: "tool",
        label: error ? `${name} failed` : childToolEventLabel(name, true),
        detail: childToolEventDetail(error),
        name,
        callId,
        icon: error ? "error" : "tool",
        status: error ? "error" : "done",
      }, callId);
    } else if (event.kind === "final" && !content.trim()) {
      content = eventText(event, "content");
      streamParts = appendTextStreamPart(streamParts, content);
    } else if (event.kind === "error") {
      const message = eventText(event, "message");
      streamParts = appendEventStreamPart(streamParts, {
        kind: "event",
        eventType: "error",
        label: "Error",
        detail: childToolEventDetail(message),
        icon: "error",
        status: "error",
      });
    }
  }
  return { content, streamParts: streamParts.length ? streamParts : undefined };
}

function messagesFromThread(thread: ChildThreadInfo, existing?: ChatMessage[], events?: ThreadEvent[]): ChatMessage[] {
  const user = existing?.find((message) => message.role === "user") ?? { role: "user", content: "" };
  const assistant = existing?.find((message) => message.role === "assistant");
  const stream = childStreamFromEvents(events);
  const streamParts = events ? stream.streamParts : assistant?.streamParts;
  const streamContent = stream.content.trim() ? stream.content : "";
  const content =
    streamContent ||
    thread.summary?.trim() ||
    thread.error?.trim() ||
    (thread.status === "queued" || thread.status === "running" ? "Working..." : "");
  return [
    { ...user, content: thread.prompt },
    ...(content || streamParts ? [{ ...(assistant ?? { role: "assistant", content: "" }), content, streamParts }] : []),
  ];
}

function sessionFromThread(parent: Session | undefined, existing: Session | undefined, thread: ChildThreadInfo, events?: ThreadEvent[]): Session {
  return {
    id: thread.id,
    parentId: thread.parent_id,
    title: thread.title || existing?.title || "Worker",
    messages: messagesFromThread(thread, existing?.messages, events),
    settings: normalizeSettings({ ...(existing?.settings ?? parent?.settings), model: thread.model, activeAgentId: thread.agent_id ?? null }),
    worker: workerFromThread(thread),
    createdAt: existing?.createdAt ?? threadTime(thread.created_at),
    updatedAt: threadTime(thread.updated_at),
  };
}

interface SessionState {
  sessions: Session[];
  projects: Project[];
  activeId: string;
  archiveRetentionDays: ArchiveRetentionDays;
  generatingSessionIds: string[];
  unreadSessionIds: string[];
  queuedMessagesBySession: Record<string, QueuedMessage[]>;
  sidebar: SessionSidebarState;
  newChat: (settings?: ThreadSettingsPatch) => void;
  forkSession: (id: string, throughMessageIndex?: number) => string | null;
  importSession: (session: Partial<Omit<Session, "settings">> & { settings?: ThreadSettingsPatch }) => string | null;
  switchTo: (id: string) => void;
  rename: (id: string, title: string) => void;
  remove: (id: string) => void;
  archiveSession: (id: string) => void;
  restoreSession: (id: string) => void;
  archiveProject: (id: string) => void;
  restoreProject: (id: string) => void;
  removeProject: (id: string) => void;
  purgeExpiredArchives: (now?: number) => void;
  setArchiveRetentionDays: (days: ArchiveRetentionDays) => void;
  setSessionGenerating: (id: string, generating: boolean) => void;
  setSessionUnread: (id: string, unread: boolean) => void;
  enqueueQueuedMessage: (id: string, message: { content: string; attachments?: ChatAttachment[] }) => QueuedMessage;
  updateQueuedMessage: (id: string, messageId: string, patch: Partial<Pick<QueuedMessage, "content" | "attachments">>) => void;
  removeQueuedMessage: (id: string, messageId: string) => void;
  shiftQueuedMessage: (id: string) => QueuedMessage | null;
  clearQueuedMessages: (id: string) => void;
  addProjectFolder: (folder: string) => void;
  setSessionFolder: (id: string, folder: string) => void;
  toggleSessionPinned: (id: string) => void;
  toggleSidebarSectionCollapsed: (id: string) => void;
  toggleSidebarSectionPinned: (id: string) => void;
  moveSidebarSection: (id: string, targetId?: string | null, position?: SidebarInsertPosition) => void;
  moveSessionInSidebar: (id: string, targetId?: string | null, targetSectionId?: string | null, position?: SidebarInsertPosition) => void;
  setMessages: (id: string, messages: ChatMessage[], options?: { autoTitle?: boolean }) => void;
  appendStreamChunks: (id: string, chunks: BufferedStreamChunk[]) => void;
  appendToken: (id: string, token: string) => void;
  appendThinkingToken: (id: string, token: string) => void;
  appendStreamEvent: (id: string, part: ChatStreamEventPart) => void;
  completeStreamEvent: (id: string, name: string, part: ChatStreamEventPart, callId?: string) => void;
  commitRun: (id: string, run: RunTrace) => void;
  commitResponseMetrics: (id: string, metrics: ResponseMetrics) => void;
  appendMemoryNotice: (id: string, notice: MemoryNotice) => void;
  upsertChildThread: (parentId: string, thread: ChildThreadInfo, events?: ThreadEvent[]) => void;
  updateChildThread: (thread: ChildThreadInfo, events?: ThreadEvent[]) => void;
  markArtifactSaved: (id: string, messageIndex: number, artifactId: string, saved: SavedArtifactFile) => void;
  setArtifactPanelOpen: (id: string, open: boolean) => void;
  setSidePanelOpen: (id: string, open: boolean) => void;
  setSidePanelMode: (id: string, mode: SessionSidePanelMode | null) => void;
  setArtifactPanelTab: (id: string, tab: SessionArtifactPanelTab) => void;
  setPreviewRuntime: (id: string, runtime: SessionPreviewRuntime | undefined) => void;
  setAccountRuntime: (id: string, runtime: Partial<NonNullable<Session["accountRuntime"]>>) => void;
  clearAccountRuntime: (id: string) => void;
  ensureClaudeSessionId: (id: string) => string;
  getSettings: (id: string) => ThreadSettings;
  updateSettings: (id: string, settings: ThreadSettingsPatch) => void;
}

export const useSessions = create<SessionState>()(
  persist(
    (set, get) => {
      const first = freshSession();
      return {
        sessions: [first],
        projects: [],
        activeId: first.id,
        archiveRetentionDays: DEFAULT_ARCHIVE_RETENTION_DAYS,
        generatingSessionIds: [],
        unreadSessionIds: [],
        queuedMessagesBySession: {},
        sidebar: normalizeSidebarState(DEFAULT_SIDEBAR_STATE, [first]),

        newChat: (settings) => {
          const cur = get().sessions.find((s) => s.id === get().activeId);
          const nextSettings = normalizeSettings(settings ?? cur?.settings);
          if (cur && cur.messages.length === 0) {
            if (settings) get().updateSettings(cur.id, nextSettings);
            return;
          }
          const s = freshSession(nextSettings);
          set((st) => ({
            sessions: [s, ...st.sessions],
            projects: upsertProject(st.projects, nextSettings.folder),
            activeId: s.id,
            sidebar: normalizeSidebarState(
              {
                ...st.sidebar,
                projectFolders: nextSettings.folder ? [nextSettings.folder, ...st.sidebar.projectFolders] : st.sidebar.projectFolders,
                sessionOrder: [s.id, ...st.sidebar.sessionOrder],
              },
              [s, ...st.sessions],
            ),
          }));
        },

        forkSession: (id, throughMessageIndex) => {
          let forkId: string | null = null;
          set((st) => {
            const source = st.sessions.find((session) => session.id === id);
            if (!source) return {};
            const end = throughMessageIndex == null
              ? source.messages.length
              : Math.max(0, Math.min(source.messages.length, throughMessageIndex + 1));
            const messages = cloneMessages(source.messages.slice(0, end)).map(normalizeMessageArtifacts);
            const now = Date.now();
            const fork: Session = {
              id: uid(),
              title: branchTitle(source.title),
              messages,
              settings: normalizeSettings(source.settings, { pauseRunningGoal: true }),
              parentId: source.id,
              createdAt: now,
              updatedAt: now,
            };
            forkId = fork.id;
            return {
              sessions: [fork, ...st.sessions],
              projects: upsertProject(st.projects, fork.settings?.folder ?? ""),
              activeId: fork.id,
              sidebar: normalizeSidebarState(
                {
                  ...st.sidebar,
                  projectFolders: fork.settings?.folder ? [fork.settings.folder, ...st.sidebar.projectFolders] : st.sidebar.projectFolders,
                  sessionOrder: [fork.id, ...st.sidebar.sessionOrder],
                },
                [fork, ...st.sessions],
              ),
            };
          });
          return forkId;
        },

        importSession: (session) => {
          let importedId: string | null = null;
          set((st) => {
            const settings = normalizeSettings(session.settings, { pauseRunningGoal: true });
            const messages = importedMessages(session.messages);
            const now = Date.now();
            const imported: Session = {
              id: uid(),
              title: importedTitle(session.title),
              messages,
              settings,
              createdAt: now,
              updatedAt: now,
            };
            importedId = imported.id;
            return {
              sessions: [imported, ...st.sessions],
              projects: upsertProject(st.projects, settings.folder),
              activeId: imported.id,
              sidebar: normalizeSidebarState(
                {
                  ...st.sidebar,
                  projectFolders: settings.folder ? [settings.folder, ...st.sidebar.projectFolders] : st.sidebar.projectFolders,
                  sessionOrder: [imported.id, ...st.sidebar.sessionOrder],
                },
                [imported, ...st.sessions],
              ),
            };
          });
          return importedId;
        },

        switchTo: (id) =>
          set((st) => ({
            activeId: id,
            unreadSessionIds: st.unreadSessionIds.filter((unreadId) => unreadId !== id),
          })),

        rename: (id, title) =>
          set((st) => ({
            sessions: st.sessions.map((s) => (s.id === id ? { ...s, title: title || "Untitled" } : s)),
          })),

        remove: (id) =>
          set((st) => {
            const removed = new Set([id]);
            let changed = true;
            while (changed) {
              changed = false;
              for (const session of st.sessions) {
                if (session.parentId && removed.has(session.parentId) && !removed.has(session.id)) {
                  removed.add(session.id);
                  changed = true;
                }
              }
            }
            const sessions = st.sessions.filter((s) => !removed.has(s.id));
            if (sessions.length === 0) {
              const s = freshSession();
              return {
                sessions: [s],
                projects: st.projects,
                activeId: s.id,
                generatingSessionIds: [],
                unreadSessionIds: [],
                queuedMessagesBySession: {},
                sidebar: normalizeSidebarState(DEFAULT_SIDEBAR_STATE, [s]),
              };
            }
            const active = ensureVisibleActive(st.activeId, sessions, st.projects);
            const activeId = active.activeId;
            return {
              sessions: active.sessions,
              activeId,
              generatingSessionIds: st.generatingSessionIds.filter((runningId) => !removed.has(runningId) && active.sessions.some((s) => s.id === runningId)),
              unreadSessionIds: st.unreadSessionIds.filter((unreadId) => !removed.has(unreadId) && unreadId !== activeId && active.sessions.some((s) => s.id === unreadId)),
              queuedMessagesBySession: withoutQueuedSessions(st.queuedMessagesBySession, removed),
              sidebar: normalizeSidebarState(
                {
                  ...st.sidebar,
                  pinnedSessionIds: st.sidebar.pinnedSessionIds.filter((pinnedId) => !removed.has(pinnedId)),
                  sessionOrder: st.sidebar.sessionOrder.filter((orderedId) => !removed.has(orderedId)),
                },
                active.sessions,
              ),
            };
          }),

        archiveSession: (id) =>
          set((st) => {
            if (!st.sessions.some((session) => session.id === id)) return {};
            const archived = new Set([id]);
            let changed = true;
            while (changed) {
              changed = false;
              for (const session of st.sessions) {
                if (session.parentId && archived.has(session.parentId) && !archived.has(session.id)) {
                  archived.add(session.id);
                  changed = true;
                }
              }
            }
            const now = Date.now();
            const sessions = st.sessions.map((session) =>
              archived.has(session.id) ? { ...session, archivedAt: session.archivedAt ?? now, updatedAt: now } : session,
            );
            const active = ensureVisibleActive(st.activeId, sessions, st.projects);
            return {
              sessions: active.sessions,
              activeId: active.activeId,
              generatingSessionIds: st.generatingSessionIds.filter((runningId) => !archived.has(runningId)),
              unreadSessionIds: st.unreadSessionIds.filter((unreadId) => !archived.has(unreadId)),
              queuedMessagesBySession: withoutQueuedSessions(st.queuedMessagesBySession, archived),
              sidebar: normalizeSidebarState(
                {
                  ...st.sidebar,
                  pinnedSessionIds: st.sidebar.pinnedSessionIds.filter((pinnedId) => !archived.has(pinnedId)),
                },
                active.sessions,
              ),
            };
          }),

        restoreSession: (id) =>
          set((st) => {
            if (!st.sessions.some((session) => session.id === id)) return {};
            const restored = new Set([id]);
            let changed = true;
            while (changed) {
              changed = false;
              for (const session of st.sessions) {
                if (session.parentId && restored.has(session.parentId) && !restored.has(session.id)) {
                  restored.add(session.id);
                  changed = true;
                }
              }
            }
            const sessions = st.sessions.map((session) =>
              restored.has(session.id) ? { ...session, archivedAt: undefined, updatedAt: Date.now() } : session,
            );
            const active = ensureVisibleActive(st.activeId, sessions, st.projects);
            return {
              sessions: active.sessions,
              activeId: active.activeId,
              sidebar: normalizeSidebarState(st.sidebar, active.sessions),
            };
          }),

        archiveProject: (id) =>
          set((st) => {
            const project = st.projects.find((item) => item.id === id);
            if (!project) return {};
            const now = Date.now();
            const projects = st.projects.map((item) =>
              item.id === id ? { ...item, archivedAt: item.archivedAt ?? now, updatedAt: now } : item,
            );
            const hidden = sessionIdsInFolder(st.sessions, project.folder);
            const active = ensureVisibleActive(st.activeId, st.sessions, projects);
            return {
              sessions: active.sessions,
              projects,
              activeId: active.activeId,
              generatingSessionIds: st.generatingSessionIds.filter((runningId) => !hidden.has(runningId)),
              unreadSessionIds: st.unreadSessionIds.filter((unreadId) => !hidden.has(unreadId)),
              queuedMessagesBySession: withoutQueuedSessions(st.queuedMessagesBySession, hidden),
              sidebar: normalizeSidebarState(
                {
                  ...st.sidebar,
                  collapsedSectionIds: st.sidebar.collapsedSectionIds.filter((sectionId) => sectionId !== id),
                  pinnedSectionIds: st.sidebar.pinnedSectionIds.filter((sectionId) => sectionId !== id),
                },
                active.sessions,
              ),
            };
          }),

        restoreProject: (id) =>
          set((st) => {
            if (!st.projects.some((project) => project.id === id)) return {};
            const projects = st.projects.map((project) =>
              project.id === id ? { ...project, archivedAt: undefined, updatedAt: Date.now() } : project,
            );
            const active = ensureVisibleActive(st.activeId, st.sessions, projects);
            return {
              projects,
              sessions: active.sessions,
              activeId: active.activeId,
              sidebar: normalizeSidebarState(st.sidebar, active.sessions),
            };
          }),

        removeProject: (id) =>
          set((st) => {
            const project = st.projects.find((item) => item.id === id);
            if (!project) return {};
            const removed = sessionIdsInFolder(st.sessions, project.folder);
            let changed = true;
            while (changed) {
              changed = false;
              for (const session of st.sessions) {
                if (session.parentId && removed.has(session.parentId) && !removed.has(session.id)) {
                  removed.add(session.id);
                  changed = true;
                }
              }
            }
            const projects = st.projects.filter((item) => item.id !== id);
            const sessions = st.sessions.filter((session) => !removed.has(session.id));
            const active = ensureVisibleActive(st.activeId, sessions, projects);
            return {
              projects,
              sessions: active.sessions,
              activeId: active.activeId,
              generatingSessionIds: st.generatingSessionIds.filter((runningId) => !removed.has(runningId)),
              unreadSessionIds: st.unreadSessionIds.filter((unreadId) => !removed.has(unreadId)),
              queuedMessagesBySession: withoutQueuedSessions(st.queuedMessagesBySession, removed),
              sidebar: normalizeSidebarState(
                {
                  ...st.sidebar,
                  collapsedSectionIds: st.sidebar.collapsedSectionIds.filter((sectionId) => sectionId !== id),
                  pinnedSectionIds: st.sidebar.pinnedSectionIds.filter((sectionId) => sectionId !== id),
                  projectFolders: st.sidebar.projectFolders.filter((folder) => normalizeProjectFolder(folder) !== project.folder),
                  sessionOrder: st.sidebar.sessionOrder.filter((sessionId) => !removed.has(sessionId)),
                },
                active.sessions,
              ),
            };
          }),

        purgeExpiredArchives: (now = Date.now()) =>
          set((st) => {
            const cutoff = now - st.archiveRetentionDays * DAY_MS;
            const expiredProjectIds = new Set(st.projects.filter((project) => (project.archivedAt ?? Infinity) <= cutoff).map((project) => project.id));
            const expiredProjectFolders = new Set(st.projects.filter((project) => expiredProjectIds.has(project.id)).map((project) => project.folder));
            const removed = new Set(st.sessions
              .filter((session) =>
                (session.archivedAt ?? Infinity) <= cutoff ||
                expiredProjectFolders.has(normalizeProjectFolder(session.settings?.folder)),
              )
              .map((session) => session.id));
            let changed = true;
            while (changed) {
              changed = false;
              for (const session of st.sessions) {
                if (session.parentId && removed.has(session.parentId) && !removed.has(session.id)) {
                  removed.add(session.id);
                  changed = true;
                }
              }
            }
            if (expiredProjectIds.size === 0 && removed.size === 0) return {};
            const projects = st.projects.filter((project) => !expiredProjectIds.has(project.id));
            const sessions = st.sessions.filter((session) => !removed.has(session.id));
            const active = ensureVisibleActive(st.activeId, sessions, projects);
            return {
              projects,
              sessions: active.sessions,
              activeId: active.activeId,
              generatingSessionIds: st.generatingSessionIds.filter((runningId) => !removed.has(runningId)),
              unreadSessionIds: st.unreadSessionIds.filter((unreadId) => !removed.has(unreadId)),
              queuedMessagesBySession: withoutQueuedSessions(st.queuedMessagesBySession, removed),
              sidebar: normalizeSidebarState(
                {
                  ...st.sidebar,
                  collapsedSectionIds: st.sidebar.collapsedSectionIds.filter((sectionId) => !expiredProjectIds.has(sectionId)),
                  pinnedSectionIds: st.sidebar.pinnedSectionIds.filter((sectionId) => !expiredProjectIds.has(sectionId)),
                  projectFolders: st.sidebar.projectFolders.filter((folder) => !expiredProjectFolders.has(normalizeProjectFolder(folder))),
                  pinnedSessionIds: st.sidebar.pinnedSessionIds.filter((sessionId) => !removed.has(sessionId)),
                  sessionOrder: st.sidebar.sessionOrder.filter((sessionId) => !removed.has(sessionId)),
                },
                active.sessions,
              ),
            };
          }),

        setArchiveRetentionDays: (days) =>
          set(() => ({ archiveRetentionDays: normalizeArchiveRetentionDays(days) })),

        setSessionGenerating: (id, generating) =>
          set((st) => {
            const running = new Set(st.generatingSessionIds);
            if (generating) running.add(id);
            else running.delete(id);
            return {
              generatingSessionIds: Array.from(running),
              unreadSessionIds: generating ? st.unreadSessionIds.filter((unreadId) => unreadId !== id) : st.unreadSessionIds,
            };
          }),

        setSessionUnread: (id, unread) =>
          set((st) => {
            if (!st.sessions.some((session) => session.id === id)) return {};
            const unreadIds = new Set(st.unreadSessionIds);
            if (unread && id !== st.activeId) unreadIds.add(id);
            else unreadIds.delete(id);
            return { unreadSessionIds: Array.from(unreadIds) };
          }),

        enqueueQueuedMessage: (id, message) => {
          const item: QueuedMessage = {
            id: uid(),
            content: message.content,
            attachments: message.attachments?.length ? message.attachments : undefined,
            createdAt: Date.now(),
          };
          set((st) => {
            if (!st.sessions.some((session) => session.id === id)) return {};
            return {
              queuedMessagesBySession: {
                ...st.queuedMessagesBySession,
                [id]: [...(st.queuedMessagesBySession[id] ?? []), item],
              },
            };
          });
          return item;
        },

        updateQueuedMessage: (id, messageId, patch) =>
          set((st) => {
            const queue = st.queuedMessagesBySession[id];
            if (!queue?.some((message) => message.id === messageId)) return {};
            const nextQueue = queue.flatMap((message) => {
              if (message.id !== messageId) return [message];
              const next = {
                ...message,
                ...patch,
                attachments: "attachments" in patch
                  ? patch.attachments?.length ? patch.attachments : undefined
                  : message.attachments,
              };
              return next.content.trim() || next.attachments?.length ? [next] : [];
            });
            const nextBySession = { ...st.queuedMessagesBySession };
            if (nextQueue.length) nextBySession[id] = nextQueue;
            else delete nextBySession[id];
            return { queuedMessagesBySession: nextBySession };
          }),

        removeQueuedMessage: (id, messageId) =>
          set((st) => {
            const queue = st.queuedMessagesBySession[id];
            if (!queue?.some((message) => message.id === messageId)) return {};
            const nextQueue = queue.filter((message) => message.id !== messageId);
            const nextBySession = { ...st.queuedMessagesBySession };
            if (nextQueue.length) nextBySession[id] = nextQueue;
            else delete nextBySession[id];
            return { queuedMessagesBySession: nextBySession };
          }),

        shiftQueuedMessage: (id) => {
          const item = get().queuedMessagesBySession[id]?.[0] ?? null;
          if (!item) return null;
          get().removeQueuedMessage(id, item.id);
          return item;
        },

        clearQueuedMessages: (id) =>
          set((st) => {
            if (!st.queuedMessagesBySession[id]?.length) return {};
            const nextBySession = { ...st.queuedMessagesBySession };
            delete nextBySession[id];
            return { queuedMessagesBySession: nextBySession };
          }),

        addProjectFolder: (folder) =>
          set((st) => {
            const normalized = normalizeProjectFolder(folder);
            if (!normalized) return {};
            return {
              projects: upsertProject(st.projects, normalized),
              sidebar: normalizeSidebarState(
                {
                  ...st.sidebar,
                  projectFolders: [normalized, ...st.sidebar.projectFolders],
                  sectionOrder: [projectSectionId(normalized), ...st.sidebar.sectionOrder],
                },
                st.sessions,
              ),
            };
          }),

        setSessionFolder: (id, folder) =>
          set((st) => {
            const normalized = normalizeProjectFolder(folder);
            const sessions = st.sessions.map((s) =>
              s.id === id
                ? {
                    ...s,
                    settings: normalizeSettings({ ...s.settings, folder: normalized }),
                    updatedAt: Date.now(),
                  }
                : s,
            );
            return {
              sessions,
              projects: upsertProject(st.projects, normalized),
              sidebar: normalizeSidebarState(
                {
                  ...st.sidebar,
                  projectFolders: normalized ? [normalized, ...st.sidebar.projectFolders] : st.sidebar.projectFolders,
                },
                sessions,
              ),
            };
          }),

        toggleSessionPinned: (id) =>
          set((st) => {
            if (!st.sessions.some((session) => session.id === id)) return {};
            const pinned = new Set(st.sidebar.pinnedSessionIds);
            if (pinned.has(id)) pinned.delete(id);
            else pinned.add(id);
            return {
              sidebar: normalizeSidebarState({ ...st.sidebar, pinnedSessionIds: Array.from(pinned) }, st.sessions),
            };
          }),

        toggleSidebarSectionCollapsed: (id) =>
          set((st) => {
            const collapsed = new Set(st.sidebar.collapsedSectionIds);
            if (collapsed.has(id)) collapsed.delete(id);
            else collapsed.add(id);
            return {
              sidebar: normalizeSidebarState({ ...st.sidebar, collapsedSectionIds: Array.from(collapsed) }, st.sessions),
            };
          }),

        toggleSidebarSectionPinned: (id) =>
          set((st) => {
            if (!isSidebarProjectSectionId(id)) return {};
            const pinned = new Set(st.sidebar.pinnedSectionIds);
            const willPin = !pinned.has(id);
            if (willPin) pinned.add(id);
            else pinned.delete(id);
            return {
              sidebar: normalizeSidebarState(
                {
                  ...st.sidebar,
                  pinnedSectionIds: Array.from(pinned),
                  sectionOrder: willPin ? moveInOrder(st.sidebar.sectionOrder, id) : st.sidebar.sectionOrder,
                },
                st.sessions,
              ),
            };
          }),

        moveSidebarSection: (id, targetId, position) =>
          set((st) => {
            if (!targetId) return {};
            if (!isSidebarProjectSectionId(id) || !isSidebarProjectSectionId(targetId)) return {};
            return {
              sidebar: normalizeSidebarState(
                { ...st.sidebar, sectionOrder: moveInOrder(st.sidebar.sectionOrder, id, targetId, position) },
                st.sessions,
              ),
            };
          }),

        moveSessionInSidebar: (id, targetId, targetSectionId, position) =>
          set((st) => {
            if (!st.sessions.some((session) => session.id === id)) return {};
            const targetFolder = targetSectionId ? folderFromProjectSectionId(targetSectionId) : null;
            const targetPinned = targetSectionId === SIDEBAR_PINNED_SECTION_ID;
            const pinned = new Set(st.sidebar.pinnedSessionIds);
            if (targetSectionId) {
              if (targetPinned) pinned.add(id);
              else pinned.delete(id);
            }
            const sessions = st.sessions.map((s) =>
              s.id === id && targetFolder !== null
                ? {
                    ...s,
                    settings: normalizeSettings({ ...s.settings, folder: targetFolder }),
                    updatedAt: Date.now(),
                  }
                : s,
            );
            return {
              sessions,
              projects: upsertProject(st.projects, targetFolder ?? ""),
              sidebar: normalizeSidebarState(
                {
                  ...st.sidebar,
                  pinnedSessionIds: Array.from(pinned),
                  projectFolders: targetFolder ? [targetFolder, ...st.sidebar.projectFolders] : st.sidebar.projectFolders,
                  sessionOrder: moveInOrder(st.sidebar.sessionOrder, id, targetId, position),
                },
                sessions,
              ),
            };
          }),

        setMessages: (id, messages, options) =>
          set((st) => ({
            sessions: st.sessions.map((s) =>
              s.id === id
                ? {
                    ...s,
                    messages: messages.map(normalizeMessageArtifacts),
                    updatedAt: Date.now(),
                    title: s.title === NEW_CHAT_TITLE && options?.autoTitle !== false ? deriveThreadTitle(messages) : s.title,
                  }
                : s,
            ),
          })),

        appendStreamChunks: (id, chunks) => {
          const stop = startPerfMeasure("store.appendStreamChunks");
          recordPerfMeasure("store.appendStreamChunks.batchChunks", chunks.length);
          recordPerfMeasure("store.appendStreamChunks.batchChars", chunks.reduce((sum, chunk) => sum + chunk.content.length, 0));
          try {
            set((st) => ({
              sessions: st.sessions.map((s) =>
                s.id === id
                  ? {
                    ...s,
                    messages: appendStreamChunksToMessages(s.messages, chunks),
                  }
                : s,
              ),
            }));
          } finally {
            stop();
          }
        },

        appendToken: (id, token) =>
          set((st) => ({
            sessions: st.sessions.map((s) =>
              s.id === id
                ? {
                    ...s,
                    messages: appendStreamChunksToMessages(s.messages, [{ kind: "text", content: token }]),
                  }
                : s,
            ),
          })),

        appendThinkingToken: (id, token) =>
          set((st) => ({
            sessions: st.sessions.map((s) =>
              s.id === id
                ? {
                    ...s,
                    messages: appendStreamChunksToMessages(s.messages, [{ kind: "thinking", content: token }]),
                  }
                : s,
            ),
          })),

        appendStreamEvent: (id, part) =>
          set((st) => ({
            sessions: st.sessions.map((s) => {
              if (s.id !== id) return s;
              const messages = s.messages.slice();
              const last = messages[messages.length - 1];
              if (last) {
                messages[messages.length - 1] = {
                  ...last,
                  streamParts: appendEventStreamPart(last.streamParts, part),
                };
              }
              return { ...s, messages, updatedAt: Date.now() };
            }),
          })),

        completeStreamEvent: (id, name, part, callId) =>
          set((st) => ({
            sessions: st.sessions.map((s) => {
              if (s.id !== id) return s;
              const messages = s.messages.slice();
              const last = messages[messages.length - 1];
              if (last) {
                messages[messages.length - 1] = {
                  ...last,
                  streamParts: completeEventStreamPart(last.streamParts, name, part, callId),
                };
              }
              return { ...s, messages, updatedAt: Date.now() };
            }),
          })),

        commitRun: (id, run) =>
          set((st) => ({
            sessions: st.sessions.map((s) => {
              if (s.id !== id) return s;
              const messages = s.messages.slice();
              const last = messages[messages.length - 1];
              if (last) messages[messages.length - 1] = normalizeMessageArtifacts({ ...last, run });
              return { ...s, messages, updatedAt: Date.now() };
            }),
          })),

        commitResponseMetrics: (id, metrics) =>
          set((st) => ({
            sessions: st.sessions.map((s) => {
              if (s.id !== id) return s;
              const messages = s.messages.slice();
              for (let index = messages.length - 1; index >= 0; index -= 1) {
                if (messages[index].role !== "assistant") continue;
                messages[index] = { ...messages[index], metrics };
                return { ...s, messages, updatedAt: Date.now() };
              }
              return s;
            }),
          })),

        appendMemoryNotice: (id, notice) =>
          set((st) => ({
            sessions: st.sessions.map((s) => {
              if (s.id !== id) return s;
              const messages = s.messages.slice();
              const last = messages[messages.length - 1];
              if (!last || last.role !== "assistant") return s;
              const existing = last.memories ?? [];
              if (existing.some((memory) => memory.id === notice.id || memory.node_id === notice.node_id)) return s;
              messages[messages.length - 1] = { ...last, memories: [...existing, notice] };
              return { ...s, messages, updatedAt: Date.now() };
            }),
          })),

        upsertChildThread: (parentId, thread, events) =>
          set((st) => {
            const parent = st.sessions.find((session) => session.id === parentId);
            const existing = st.sessions.find((session) => session.id === thread.id);
            const child = sessionFromThread(parent, existing, { ...thread, parent_id: parentId || thread.parent_id }, events);
            const sessions = existing
              ? st.sessions.map((session) => (session.id === thread.id ? child : session))
              : (() => {
                  const insertAt = st.sessions.findIndex((session) => session.id === parentId);
                  const next = st.sessions.slice();
                  next.splice(insertAt >= 0 ? insertAt + 1 : 0, 0, child);
                  return next;
                })();
            return {
              sessions,
              sidebar: normalizeSidebarState(
                {
                  ...st.sidebar,
                  sessionOrder: orderedUnique(st.sidebar.sessionOrder, sessions.map((session) => session.id)),
                },
                sessions,
              ),
            };
          }),

        updateChildThread: (thread, events) =>
          set((st) => {
            const existing = st.sessions.find((session) => session.id === thread.id);
            const parent = st.sessions.find((session) => session.id === (existing?.parentId ?? thread.parent_id));
            if (!existing && !parent) return {};
            const child = sessionFromThread(parent, existing, thread, events);
            const sessions = existing
              ? st.sessions.map((session) => (session.id === thread.id ? child : session))
              : [child, ...st.sessions];
            return { sessions, sidebar: normalizeSidebarState(st.sidebar, sessions) };
          }),

        markArtifactSaved: (id, messageIndex, artifactId, saved) =>
          set((st) => ({
            sessions: st.sessions.map((s) => {
              if (s.id !== id) return s;
              const messages = s.messages.slice();
              const message = messages[messageIndex];
              if (!message?.artifacts?.length) return s;
              messages[messageIndex] = {
                ...message,
                artifacts: message.artifacts.map((artifact) =>
                  artifact.id === artifactId ? { ...artifact, saved } : artifact,
                ),
              };
              return { ...s, messages, updatedAt: Date.now() };
            }),
          })),

        setArtifactPanelOpen: (id, open) =>
          set((st) => ({
            sessions: st.sessions.map((s) =>
              s.id === id ? { ...s, artifactPanelOpen: open || undefined, sidePanelMode: open ? s.sidePanelMode ?? "artifact" : s.sidePanelMode, updatedAt: Date.now() } : s,
            ),
          })),

        setSidePanelOpen: (id, open) =>
          set((st) => ({
            sessions: st.sessions.map((s) =>
              s.id === id ? { ...s, artifactPanelOpen: open || undefined, sidePanelMode: open ? s.sidePanelMode ?? "browser" : s.sidePanelMode, updatedAt: Date.now() } : s,
            ),
          })),

        setSidePanelMode: (id, mode) =>
          set((st) => ({
            sessions: st.sessions.map((s) =>
              s.id === id
                ? {
                    ...s,
                    artifactPanelOpen: mode ? true : undefined,
                    sidePanelMode: mode || undefined,
                    updatedAt: Date.now(),
                  }
                : s,
            ),
          })),

        setArtifactPanelTab: (id, tab) =>
          set((st) => ({
            sessions: st.sessions.map((s) =>
              s.id === id ? { ...s, artifactPanelTab: tab === "code" ? "code" : undefined, updatedAt: Date.now() } : s,
            ),
          })),

        setPreviewRuntime: (id, runtime) =>
          set((st) => ({
            sessions: st.sessions.map((s) => {
              if (s.id !== id) return s;
              const previewRuntime = normalizePreviewRuntime(runtime);
              if (samePreviewRuntime(s.previewRuntime, previewRuntime)) return s;
              return { ...s, previewRuntime: previewRuntime ? { ...previewRuntime, updatedAt: Date.now() } : undefined };
            }),
          })),

        setAccountRuntime: (id, runtime) =>
          set((st) => ({
            sessions: st.sessions.map((s) => {
              if (s.id !== id) return s;
              const accountRuntime = normalizeAccountRuntime({ ...s.accountRuntime, ...runtime });
              return { ...s, accountRuntime, updatedAt: Date.now() };
            }),
          })),

        clearAccountRuntime: (id) =>
          set((st) => ({
            sessions: st.sessions.map((s) =>
              s.id === id ? { ...s, accountRuntime: undefined, updatedAt: Date.now() } : s,
            ),
          })),

        ensureClaudeSessionId: (id) => {
          const existing = get().sessions.find((s) => s.id === id)?.accountRuntime?.claudeSessionId;
          if (existing) return existing;
          const claudeSessionId = runtimeUuid();
          get().setAccountRuntime(id, { claudeSessionId });
          return claudeSessionId;
        },

        getSettings: (id) => {
          const session = get().sessions.find((s) => s.id === id);
          return normalizeSettings(session?.settings);
        },

        updateSettings: (id, settings) =>
          set((st) => {
            const nextFolder = "folder" in settings ? normalizeProjectFolder(settings.folder) : null;
            const sessions = st.sessions.map((s) =>
              s.id === id
                ? (() => {
                    const merged = { ...s.settings, ...settings };
                    if ("goal" in settings) {
                      merged.goal = {
                        ...(s.settings?.goal ?? DEFAULT_GOAL_SETTINGS),
                        ...(settings.goal ?? {}),
                      };
                    }
                    return {
                      ...s,
                      settings: normalizeSettings(merged),
                      updatedAt: Date.now(),
                    };
                  })()
                : s,
            );
            return {
              sessions,
              projects: upsertProject(st.projects, nextFolder ?? ""),
              sidebar: normalizeSidebarState(
                {
                  ...st.sidebar,
                  projectFolders: nextFolder ? [nextFolder, ...st.sidebar.projectFolders] : st.sidebar.projectFolders,
                },
                sessions,
              ),
            };
          }),
      };
    },
    {
      name: "milim.sessions",
      storage: createJSONStorage(() => userStateStorage),
      merge: (persisted, current) => {
        const state = persisted as Partial<SessionState>;
        const sessions = state.sessions?.map((session) => normalizeSessionArtifacts(session)) ?? current.sessions;
        const archiveRetentionDays = normalizeArchiveRetentionDays(state.archiveRetentionDays);
        const projects = normalizeProjects(state.projects, sessions, uniqueStrings(state.sidebar?.projectFolders));
        const cutoff = Date.now() - archiveRetentionDays * DAY_MS;
        const expiredProjectFolders = new Set(projects.filter((project) => (project.archivedAt ?? Infinity) <= cutoff).map((project) => project.folder));
        const liveProjects = projects.filter((project) => (project.archivedAt ?? Infinity) > cutoff);
        const liveSessions = sessions.filter((session) =>
          (session.archivedAt ?? Infinity) > cutoff &&
          !expiredProjectFolders.has(normalizeProjectFolder(session.settings?.folder)),
        );
        const active = ensureVisibleActive(state.activeId ?? current.activeId, liveSessions, liveProjects);
        return {
          ...current,
          ...state,
          sessions: active.sessions,
          projects: liveProjects,
          activeId: active.activeId,
          archiveRetentionDays,
          generatingSessionIds: [],
          unreadSessionIds: [],
          queuedMessagesBySession: normalizeQueuedMessagesBySession(state.queuedMessagesBySession, active.sessions),
          sidebar: normalizeSidebarState(state.sidebar, active.sessions),
        };
      },
      partialize: (state) => ({
        sessions: sessionsForPersistence(state.sessions),
        projects: state.projects,
        activeId: state.activeId,
        archiveRetentionDays: state.archiveRetentionDays,
        queuedMessagesBySession: state.queuedMessagesBySession,
        sidebar: state.sidebar,
      }),
    },
  ),
);

export function purgeExpiredArchivesAfterHydration(): () => void {
  if (useSessions.persist.hasHydrated()) {
    useSessions.getState().purgeExpiredArchives();
    return () => {};
  }
  return useSessions.persist.onFinishHydration(() => {
    useSessions.getState().purgeExpiredArchives();
  });
}
