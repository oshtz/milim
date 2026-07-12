import type {
  ChatAttachment,
  ChatMessage,
  WorkspaceGitStatus,
} from "../api";
import type { GoalSettings } from "./goals";
import { formatProviderLimits, formatThreadMetricsBreakdown, latestProviderLimits } from "./usageMetrics.js";

export type QuickSummaryTone = "ready" | "warning" | "error" | "muted";
export type QuickSummaryRowKind =
  | "workspace"
  | "plan"
  | "goal"
  | "browser"
  | "model"
  | "sources"
  | "privacy"
  | "memory"
  | "usage"
  | "limits";
export type QuickSummarySourceKind = "attachment" | "artifact" | "memory";

export interface QuickSummaryRow {
  kind: QuickSummaryRowKind;
  label: string;
  value: string;
  meta?: string;
  title?: string;
  tone?: QuickSummaryTone;
}

export interface QuickSummarySource {
  kind: QuickSummarySourceKind;
  label: string;
}

export interface QuickSummary {
  rows: QuickSummaryRow[];
  sources: QuickSummarySource[];
  model?: string;
}

export interface BuildQuickSummaryInput {
  folder: string;
  model: string;
  privacy: string;
  memory: boolean;
  planMode: boolean;
  goal: GoalSettings;
  gitStatus: WorkspaceGitStatus | null;
  messages: ChatMessage[];
  pendingAttachments?: ChatAttachment[];
  previewUrl?: string | null;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function clip(text: string, limit = 80): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit - 3).trimEnd()}...`;
}

function titleCase(value: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() + trimmed.slice(1) : "";
}

function branchLabel(status: WorkspaceGitStatus): string {
  return status.branch || (status.head ? `detached ${status.head.slice(0, 7)}` : "No commits");
}

function workspaceRow(status: WorkspaceGitStatus | null, folder: string): QuickSummaryRow {
  if (!folder.trim()) {
    return {
      kind: "workspace",
      label: "No workspace",
      value: "Pick a folder",
      tone: "muted",
    };
  }
  const name = basename(folder.trim());
  if (!status) {
    return {
      kind: "workspace",
      label: name,
      value: "Checking Git",
      title: folder,
      tone: "muted",
    };
  }
  if (status.state === "not_git") {
    return {
      kind: "workspace",
      label: status.folder ? basename(status.folder) : name,
      value: "Not a Git repo",
      title: status.folder || folder,
      tone: "muted",
    };
  }
  if (status.state !== "ready" || !status.is_repo) {
    return {
      kind: "workspace",
      label: name,
      value: status.message || "Git unavailable",
      title: status.folder || folder,
      tone: "warning",
    };
  }

  const changed = status.conflicts
    ? plural(status.conflicts, "conflict")
    : status.has_changes
      ? plural(status.changed_file_count || status.staged + status.unstaged + status.untracked || 1, "file")
      : "Clean";
  const diff = status.insertions || status.deletions
    ? `+${status.insertions.toLocaleString()} -${status.deletions.toLocaleString()}`
    : "";
  const sync = status.ahead || status.behind
    ? `${status.ahead} ahead / ${status.behind} behind`
    : "";

  return {
    kind: "workspace",
    label: status.folder ? basename(status.folder) : name,
    value: [branchLabel(status), changed, diff].filter(Boolean).join(" - "),
    meta: sync || undefined,
    title: status.folder || folder,
    tone: status.conflicts ? "error" : status.has_changes ? "warning" : "ready",
  };
}

function compactModelLabel(model: string): string {
  const value = model.trim();
  if (!value) return "No model selected";
  if (value.length <= 34) return value;
  const tokens = value.split(/[/:_\-\s.]+/).filter(Boolean);
  if (tokens.length <= 4) return tokens.join(" ");
  const anchors = ["codex", "gpt", "claude", "gemini", "llama", "qwen", "mistral", "deepseek", "mythos"];
  const start = tokens.findIndex((token) => {
    const lower = token.toLowerCase();
    return anchors.some((anchor) => lower.includes(anchor));
  });
  return (start >= 0 ? tokens.slice(start, start + 4) : tokens.slice(-4)).join(" ");
}

function formatPreviewUrl(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    return `${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return clip(trimmed, 54);
  }
}

function latestPlan(messages: ChatMessage[]): ChatMessage["plan"] | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].plan) return messages[i].plan ?? null;
  }
  return null;
}

function appendSource(
  sources: QuickSummarySource[],
  seen: Set<string>,
  kind: QuickSummarySourceKind,
  label: string,
): void {
  const value = clip(label);
  if (!value) return;
  const key = `${kind}:${value.toLowerCase()}`;
  if (seen.has(key)) return;
  seen.add(key);
  sources.push({ kind, label: value });
}

function attachmentLabel(attachment: ChatAttachment): string {
  return attachment.sourcePath || attachment.name || attachment.id;
}

function summarySources(
  messages: ChatMessage[],
  pendingAttachments: ChatAttachment[] = [],
): QuickSummarySource[] {
  const sources: QuickSummarySource[] = [];
  const seen = new Set<string>();
  for (const attachment of pendingAttachments) {
    appendSource(sources, seen, "attachment", `Pending: ${attachmentLabel(attachment)}`);
  }
  for (const message of messages.slice(-12)) {
    for (const attachment of message.attachments ?? []) {
      appendSource(sources, seen, "attachment", attachmentLabel(attachment));
    }
    for (const artifact of message.artifacts ?? []) {
      appendSource(
        sources,
        seen,
        "artifact",
        artifact.saved?.path || artifact.filename || artifact.title || artifact.id,
      );
    }
    for (const memory of message.memories ?? []) {
      appendSource(sources, seen, "memory", memory.summary || memory.scope_label);
    }
  }
  return sources;
}

export function buildQuickSummary(input: BuildQuickSummaryInput): QuickSummary {
  const folder = input.folder.trim();
  const plan = latestPlan(input.messages);
  const goalObjective = input.goal.objective.trim();
  const sources = summarySources(input.messages, input.pendingAttachments);
  const rows: QuickSummaryRow[] = [workspaceRow(input.gitStatus, folder)];

  if (goalObjective) {
    rows.push({
      kind: "goal",
      label: `${titleCase(input.goal.status)} goal`,
      value: clip(goalObjective, 86),
      tone: input.goal.status === "error" || input.goal.status === "blocked" ? "error" : "warning",
    });
  } else if (input.planMode) {
    rows.push({
      kind: "plan",
      label: "Plan mode",
      value: "Read-only planning",
      tone: "warning",
    });
  } else if (plan) {
    rows.push({
      kind: "plan",
      label: plan.status === "executed" ? "Plan executed" : "Plan proposed",
      value: "Latest assistant plan",
      tone: "muted",
    });
  }

  const previewUrl = formatPreviewUrl(input.previewUrl);
  if (previewUrl) {
    rows.push({
      kind: "browser",
      label: "Browser",
      value: previewUrl,
      title: input.previewUrl ?? undefined,
    });
  }

  rows.push({
    kind: "model",
    label: "Model",
    value: compactModelLabel(input.model),
    title: input.model.trim() || undefined,
    tone: input.model.trim() ? undefined : "muted",
  });

  const usage = formatThreadMetricsBreakdown(input.messages);
  if (usage.label) {
    rows.push({
      kind: "usage",
      label: "Thread usage",
      value: usage.label,
      title: usage.title ?? undefined,
    });
  }

  const limits = formatProviderLimits(latestProviderLimits(input.messages));
  if (limits) {
    rows.push({
      kind: "limits",
      label: "Provider quota",
      value: limits,
    });
  }

  if (input.privacy && input.privacy !== "off") {
    rows.push({
      kind: "privacy",
      label: "Privacy",
      value: titleCase(input.privacy),
      tone: input.privacy === "block" ? "error" : "warning",
    });
  }

  if (!input.memory) {
    rows.push({
      kind: "memory",
      label: "Memory",
      value: "Off",
      tone: "muted",
    });
  }

  rows.push({
    kind: "sources",
    label: "Sources",
    value: sources.length ? plural(sources.length, "source") : "None",
    meta: sources.slice(0, 2).map((source) => source.label).join(" - ") || undefined,
    title: sources.map((source) => source.label).join("\n") || undefined,
    tone: sources.length ? undefined : "muted",
  });

  return {
    rows,
    sources,
    model: input.model,
  };
}
