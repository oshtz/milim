import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  claudeRuntimeModel,
  codexRuntimeModel,
  completeChat,
  getWorkspaceGitStatus,
  listModelsDetailed,
  openArtifactLocation,
  openExternalUrl,
  runWorkspaceGitAction,
  setWorkspace,
  streamClaudeRun,
  streamCodexRun,
  type ClaudeRunEvent,
  type CodexRunEvent,
  type WorkspaceGitAction,
  type WorkspaceGitActionResult,
  type WorkspaceGitStatus,
  type WorkspaceGitBranch,
  type WorkspaceGitFileChange,
} from "../api";
import { commitMessageModelCandidates } from "../lib/gitCommitMessageModels";
import {
  diffRows,
  diffSections,
  diffStats,
  shouldCollapseDiffSection,
  type DiffRow,
  type DiffSection,
} from "../lib/gitDiffRows";
import { shouldRefreshGitStatus } from "../lib/gitRefresh";
import { useUiPreferences } from "../ui/store";
import { useContextMenu } from "./ContextMenu";
import {
  ArrowUp,
  ChevronDown,
  Code,
  Copy,
  Download,
  Folder,
  GitBranch,
  GitCommit,
  GitLogo,
  GitRemote,
  Lightbulb,
  Refresh,
  Search,
  X,
} from "./icons";

const FILE_PREVIEW_LIMIT = 3;
const COMMIT_MESSAGE_DIFF_LIMIT = 18_000;
const COMMIT_MESSAGE_SYSTEM_PROMPT =
  "Write one professional Git commit subject. Return exactly one line, no markdown, no quotes. Use imperative mood when natural. Keep it under 72 characters.";

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function compactPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 1 ? parts.slice(-2).join("/") : parts[0] || path;
}

function cleanGitPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function gitStatusLabel(status: string): string {
  if (status === "??") return "new";
  if (status.includes("U")) return "conf";
  if (status.includes("R")) return "ren";
  if (status.includes("D")) return "del";
  if (status.includes("A")) return "add";
  if (status.includes("M")) return "mod";
  return status || "changed";
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function branchLabel(status: WorkspaceGitStatus): string {
  return (
    status.branch || (status.head ? `detached ${status.head}` : "No commits")
  );
}

function changedFilesCount(status: WorkspaceGitStatus): number {
  return status.changed_file_count;
}

function changeLabel(status: WorkspaceGitStatus): string {
  if (status.conflicts) return plural(status.conflicts, "conflict");
  if (status.has_changes) return `${changedFilesCount(status)} changed`;
  return "Clean";
}

function diffLabel(status: WorkspaceGitStatus): string | null {
  return status.insertions || status.deletions
    ? `+${status.insertions.toLocaleString()}/-${status.deletions.toLocaleString()}`
    : null;
}

function renderDiffStat(status: WorkspaceGitStatus): ReactNode {
  if (!status.insertions && !status.deletions) return null;
  return (
    <span
      className="git-diff-stat"
      aria-label={`${status.insertions.toLocaleString()} insertions, ${status.deletions.toLocaleString()} deletions`}
    >
      <span className="git-diff-stat-add">
        +{status.insertions.toLocaleString()}
      </span>
      <span className="git-diff-stat-separator">/</span>
      <span className="git-diff-stat-delete">
        -{status.deletions.toLocaleString()}
      </span>
    </span>
  );
}

function compactChangeLabel(status: WorkspaceGitStatus): string {
  return [changeLabel(status), diffLabel(status)].filter(Boolean).join(" / ");
}

function changeTone(
  status: WorkspaceGitStatus,
): "clean" | "dirty" | "conflict" {
  if (status.conflicts) return "conflict";
  return status.has_changes ? "dirty" : "clean";
}

function syncLabel(status: WorkspaceGitStatus): string {
  if (status.ahead || status.behind) {
    return `${status.ahead} ahead / ${status.behind} behind`;
  }
  if (status.upstream) return "Up to date";
  if (status.remote) return "No upstream";
  return "No remote";
}

function branchMetaLabel(branch: WorkspaceGitBranch): string {
  const sync =
    branch.ahead || branch.behind
      ? ` · ${branch.ahead} ahead / ${branch.behind} behind`
      : "";
  return `${branch.current ? "current" : branch.upstream ? branch.upstream : "local"}${sync}`;
}

function remoteWebUrl(remote: string | null): string | null {
  if (!remote) return null;
  const trimmed = remote.trim().replace(/\.git$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;

  const ssh = trimmed.match(/^ssh:\/\/(?:[^@]+@)?([^/]+)\/(.+)$/i);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;

  const scp = trimmed.match(
    /^(?:[^@\\/\s]+@)?([^:\\/\s]+(?:\.[^:\\/\s]+)+):([^\\\s]+\/[^\\\s]+)$/,
  );
  return scp ? `https://${scp[1]}/${scp[2]}` : null;
}

function gitStateLabel(status: WorkspaceGitStatus | null): string {
  if (!status) return "Git unavailable";
  if (status.state === "not_git") return "Not a Git repo";
  if (status.state === "no_folder") return "No folder selected";
  if (status.state === "error") return "Git unavailable";
  return status.message || "Git unavailable";
}

function updatedLabel(updatedAt: number | null, now: number): string {
  if (!updatedAt) return "";
  const minutes = Math.floor((now - updatedAt) / 60000);
  if (minutes < 1) return "Updated now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours}h ago`;
}

function commitPrompt(folder: string, status: WorkspaceGitStatus): string {
  return [
    "Review the Git changes in the selected working folder and prepare a commit or push plan.",
    `Folder: ${folder}`,
    `Branch: ${branchLabel(status)}`,
    "Start by running `git status --short --branch` and inspecting the diff.",
    "Summarize the changes and propose a commit message. Do not commit or push until I confirm.",
  ].join("\n");
}

function gitTaskPrompt(
  folder: string,
  status: WorkspaceGitStatus,
  task: string,
  instruction: string,
): string {
  return [
    task,
    `Folder: ${folder}`,
    `Branch: ${branchLabel(status)}`,
    "Start by running `git status --short --branch`.",
    instruction,
  ].join("\n");
}

function agentReviewPrompt(folder: string, status: WorkspaceGitStatus): string {
  if (status.conflicts) {
    return gitTaskPrompt(
      folder,
      status,
      "Review the current Git conflicts in the selected working folder.",
      "Identify conflicted files, risk, and a resolution plan. Do not edit files until I confirm.",
    );
  }
  if (status.has_changes) {
    return commitPrompt(folder, status);
  }
  return gitTaskPrompt(
    folder,
    status,
    "Review the selected working folder's Git state.",
    "Inspect the status, branch, upstream, and recent changes if relevant. Call out risks and useful next commands. Do not change the repository until I confirm.",
  );
}

function syncCommand(
  status: WorkspaceGitStatus,
): {
  action: WorkspaceGitAction;
  label: string;
  disabled?: boolean;
  title: string;
} | null {
  if (status.behind) {
    return status.has_changes
      ? {
          action: "pull",
          label: "Pull",
          disabled: true,
          title: "Clean the worktree before pulling.",
        }
      : { action: "pull", label: "Pull", title: "Run git pull --ff-only." };
  }
  if (status.ahead && status.upstream)
    return { action: "push", label: "Push", title: "Run git push." };
  if (!status.upstream && status.remote && status.branch) {
    return {
      action: "publish",
      label: "Publish",
      title: `Run git push -u origin ${status.branch}.`,
    };
  }
  return null;
}

function actionOutputText(result: WorkspaceGitActionResult): string {
  return [result.stdout, result.stderr]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function changedFileTitle(change: WorkspaceGitFileChange): string {
  return `${gitStatusLabel(change.status)} ${cleanGitPath(change.path)}`;
}

function quoteArg(value: string): string {
  return value.trim() ? JSON.stringify(value.trim()) : "<message>";
}

function commandPreview(
  action: WorkspaceGitAction,
  status: WorkspaceGitStatus,
  message: string,
  stageAll: boolean,
): string {
  if (action === "commit") {
    return `${stageAll ? "git add -A && " : ""}git commit -m ${quoteArg(message)}`;
  }
  if (action === "commit_push") {
    const push = status.upstream
      ? "git push"
      : `git push -u origin ${status.branch || "<branch>"}`;
    return `${stageAll ? "git add -A && " : ""}git commit -m ${quoteArg(message)} && ${push}`;
  }
  if (action === "pull") return "git pull --ff-only";
  if (action === "push") return "git push";
  if (action === "publish")
    return `git push -u origin ${status.branch || "<branch>"}`;
  if (action === "fetch") return "git fetch --prune";
  if (action === "checkout_branch") return "git checkout <branch>";
  if (action === "create_branch") return "git checkout -b <branch>";
  return "git diff --no-ext-diff --stat --patch HEAD --";
}

function actionLabel(action: WorkspaceGitAction): string {
  if (action === "commit_push") return "Commit and push";
  if (action === "checkout_branch") return "Checkout branch";
  if (action === "create_branch") return "Create branch";
  return action.slice(0, 1).toUpperCase() + action.slice(1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function changedSegments(
  text: string,
  other: string | null,
): { text: string; changed: boolean }[] {
  if (!other) return [{ text, changed: false }];
  let start = 0;
  const maxStart = Math.min(text.length, other.length);
  while (start < maxStart && text[start] === other[start]) start += 1;

  let end = 0;
  const maxEnd = maxStart - start;
  while (
    end < maxEnd &&
    text[text.length - 1 - end] === other[other.length - 1 - end]
  )
    end += 1;

  const before = text.slice(0, start);
  const middle = text.slice(start, text.length - end);
  const after = end ? text.slice(text.length - end) : "";
  return [
    before ? { text: before, changed: false } : null,
    middle ? { text: middle, changed: true } : null,
    after ? { text: after, changed: false } : null,
  ].filter(Boolean) as { text: string; changed: boolean }[];
}

function diffTextSegments(
  row: DiffRow,
  index: number,
  rows: DiffRow[],
): { text: string; changed: boolean }[] {
  if (row.kind === "add") {
    const previous = rows[index - 1];
    return changedSegments(
      row.text,
      previous?.kind === "delete" ? previous.text : null,
    );
  }
  if (row.kind === "delete") {
    const next = rows[index + 1];
    return changedSegments(row.text, next?.kind === "add" ? next.text : null);
  }
  return [{ text: row.text, changed: false }];
}

function renderDiffText(
  row: DiffRow,
  index: number,
  rows: DiffRow[],
  query: string,
): ReactNode {
  const term = query.trim();
  const matcher = term ? new RegExp(`(${escapeRegExp(term)})`, "ig") : null;
  let key = 0;
  return diffTextSegments(row, index, rows).flatMap((segment) => {
    const className = segment.changed ? "git-diff-changed-text" : undefined;
    if (!matcher)
      return [
        <span className={className} key={key++}>
          {segment.text}
        </span>,
      ];
    return segment.text
      .split(matcher)
      .filter(Boolean)
      .map((part) => {
        const isMatch = part.toLowerCase() === term.toLowerCase();
        return isMatch ? (
          <mark className={className} key={key++}>
            {part}
          </mark>
        ) : (
          <span className={className} key={key++}>
            {part}
          </span>
        );
      });
  });
}

function cleanGeneratedCommitMessage(text: string): string {
  const firstLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  return firstLine
    .replace(/^[-*`"'\s]+|[`"'\s]+$/g, "")
    .replace(/^(commit message|subject):\s*/i, "")
    .slice(0, 72)
    .trim();
}

function commitMessageContext(
  status: WorkspaceGitStatus,
  diff: string,
): string {
  return [
    `Branch: ${branchLabel(status)}`,
    `Files: ${status.changed_files.map((change) => `${gitStatusLabel(change.status)} ${cleanGitPath(change.path)}`).join(", ")}`,
    "Diff:",
    diff.slice(0, COMMIT_MESSAGE_DIFF_LIMIT),
  ].join("\n");
}

async function generateCommitMessage(
  model: string,
  status: WorkspaceGitStatus,
  diff: string,
): Promise<string> {
  const response = await completeChat(
    model,
    [
      {
        role: "system",
        content: COMMIT_MESSAGE_SYSTEM_PROMPT,
      },
      {
        role: "user",
        content: commitMessageContext(status, diff),
      },
    ],
    { maxTokens: 40, temperature: 0.2 },
  );
  const message = cleanGeneratedCommitMessage(response);
  if (!message) throw new Error("The model returned an empty commit message.");
  return message;
}

async function generateAccountRuntimeCommitMessage(
  preferredModel: string,
  folder: string,
  status: WorkspaceGitStatus,
  diff: string,
): Promise<string | null> {
  const codexModel = codexRuntimeModel(preferredModel);
  const claudeModel = claudeRuntimeModel(preferredModel);
  if (!codexModel && !claudeModel) return null;

  let response = "";
  let runtimeError = "";
  let runtimeWarning = "";
  const prompt = `${COMMIT_MESSAGE_SYSTEM_PROMPT}\n\n${commitMessageContext(status, diff)}`;
  const onEvent = (event: CodexRunEvent | ClaudeRunEvent) => {
    if (event.type === "token" && event.text) response += event.text;
    else if (event.type === "warning") runtimeWarning = event.message;
    else if (event.type === "error") runtimeError = event.message;
  };

  if (codexModel) {
    await streamCodexRun(
      {
        model: codexModel,
        prompt,
        cwd: folder.trim() || undefined,
        tool_approval_policy: "review",
        tool_approval_grant: false,
        plan_mode: true,
      },
      onEvent,
    );
  } else if (claudeModel) {
    await streamClaudeRun(
      {
        model: claudeModel,
        prompt,
        cwd: folder.trim() || undefined,
        tool_approval_policy: "review",
        tool_approval_grant: false,
        plan_mode: true,
      },
      onEvent,
    );
  }

  if (runtimeWarning) throw new Error(runtimeWarning);
  if (runtimeError) throw new Error(runtimeError);

  const message = cleanGeneratedCommitMessage(response);
  if (!message)
    throw new Error(
      `${codexModel ? "Codex" : "Claude CLI"} returned an empty commit message.`,
    );
  return message;
}

async function generateCommitMessageWithFallback(
  preferredModel: string,
  folder: string,
  status: WorkspaceGitStatus,
  diff: string,
): Promise<string> {
  let lastError = "";
  try {
    const accountRuntimeMessage = await generateAccountRuntimeCommitMessage(
      preferredModel,
      folder,
      status,
      diff,
    );
    if (accountRuntimeMessage) return accountRuntimeMessage;
  } catch (error) {
    lastError =
      error instanceof Error
        ? error.message
        : "account runtime generation failed";
  }

  const candidates = commitMessageModelCandidates(
    await listModelsDetailed(),
    preferredModel,
  );
  if (!candidates.length) {
    throw new Error(
      lastError ||
        "Enter a commit message, or add a reachable chat model to generate one.",
    );
  }

  for (const candidate of candidates) {
    try {
      return await generateCommitMessage(candidate, status, diff);
    } catch (error) {
      lastError = error instanceof Error ? error.message : "generation failed";
    }
  }
  throw new Error(lastError || "Couldn't generate a commit message.");
}

export function GitPanel({
  folder,
  onDraftAction,
  model,
  onOpenPanel,
  forceExpanded = false,
}: {
  folder: string;
  onDraftAction: (text: string) => void;
  model: string;
  onOpenPanel?: () => void;
  forceExpanded?: boolean;
}) {
  const { openContextMenu } = useContextMenu();
  const [status, setStatus] = useState<WorkspaceGitStatus | null>(null);
  const [statusFolder, setStatusFolder] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const lastGitStatusRunAtRef = useRef<number | null>(null);
  const expandedPreference = useUiPreferences((s) => s.gitPanelExpanded);
  const setExpanded = useUiPreferences((s) => s.setGitPanelExpanded);
  const expanded = forceExpanded || (onOpenPanel ? false : expandedPreference);
  const [notice, setNotice] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [commandBusy, setCommandBusy] = useState<WorkspaceGitAction | null>(
    null,
  );
  const [commandResult, setCommandResult] =
    useState<WorkspaceGitActionResult | null>(null);
  const [diffResult, setDiffResult] = useState<WorkspaceGitActionResult | null>(
    null,
  );
  const [commandMenu, setCommandMenu] = useState<WorkspaceGitAction | null>(
    null,
  );
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branchFilter, setBranchFilter] = useState("");
  const [newBranchName, setNewBranchName] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [generatingCommitMessage, setGeneratingCommitMessage] = useState(false);
  const [stageAll, setStageAll] = useState(true);
  const [collapsedDiffSections, setCollapsedDiffSections] = useState<
    Set<string>
  >(() => new Set());
  const [diffSearch, setDiffSearch] = useState("");
  const [diffSearchIndex, setDiffSearchIndex] = useState(0);
  const diffViewRef = useRef<HTMLDivElement | null>(null);
  const selectedFolder = folder.trim();

  useEffect(() => {
    setCommandResult(null);
    setDiffResult(null);
    setCommandMenu(null);
    setBranchMenuOpen(false);
    setBranchFilter("");
    setNewBranchName("");
    setCommandBusy(null);
    setCommitMessage("");
    setGeneratingCommitMessage(false);
    setStageAll(true);
    setCollapsedDiffSections(new Set());
    setDiffSearch("");
    setDiffSearchIndex(0);
  }, [selectedFolder]);

  useEffect(() => {
    setNotice(null);
    if (!selectedFolder) {
      setStatus(null);
      setStatusFolder("");
      setLoading(false);
      setUpdatedAt(null);
      lastGitStatusRunAtRef.current = null;
      return;
    }

    let cancelled = false;
    lastGitStatusRunAtRef.current = Date.now();
    setLoading(true);
    void (async () => {
      await setWorkspace(selectedFolder);
      const next = await getWorkspaceGitStatus();
      if (cancelled) return;
      setStatus(
        (previous) =>
          next ?? (statusFolder === selectedFolder ? previous : null),
      );
      setStatusFolder(selectedFolder);
      const timestamp = Date.now();
      setUpdatedAt(timestamp);
      setNow(timestamp);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshKey, selectedFolder]);

  useEffect(() => {
    if (!selectedFolder) return;
    function refreshOnFocus() {
      const timestamp = Date.now();
      if (!shouldRefreshGitStatus(lastGitStatusRunAtRef.current, timestamp))
        return;
      lastGitStatusRunAtRef.current = timestamp;
      setRefreshKey((value) => value + 1);
    }
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [selectedFolder]);

  useEffect(() => {
    if (!updatedAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 60000);
    return () => window.clearInterval(interval);
  }, [updatedAt]);

  useEffect(() => {
    if (!commandMenu && !branchMenuOpen && !diffResult) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setCommandMenu(null);
      setBranchMenuOpen(false);
      setDiffResult(null);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [commandMenu, branchMenuOpen, diffResult]);

  useEffect(() => {
    const output = diffResult ? actionOutputText(diffResult) : "";
    const rows = output ? diffRows(output) : [];
    setCollapsedDiffSections(
      new Set(
        diffSections(rows)
          .filter(shouldCollapseDiffSection)
          .map((section) => section.id),
      ),
    );
    setDiffSearch("");
    setDiffSearchIndex(0);
  }, [diffResult]);

  useEffect(() => {
    if (!diffSearch.trim()) return;
    const handle = window.setTimeout(() => {
      diffViewRef.current
        ?.querySelector(`[data-match-index="${diffSearchIndex}"]`)
        ?.scrollIntoView({ block: "center" });
    }, 0);
    return () => window.clearTimeout(handle);
  }, [collapsedDiffSections, diffSearch, diffSearchIndex]);

  const currentStatus = statusFolder === selectedFolder ? status : null;
  const repoName = useMemo(() => {
    const root = currentStatus?.root || selectedFolder;
    return root ? basename(root) : "Repository";
  }, [selectedFolder, currentStatus?.root]);

  function forceRefreshGitStatus() {
    lastGitStatusRunAtRef.current = Date.now();
    setRefreshKey((value) => value + 1);
  }

  if (!selectedFolder) return null;

  function openGitStateContextMenu(event: ReactMouseEvent) {
    openContextMenu(
      event,
      [
        {
          id: "refresh",
          label: "Refresh Git status",
          icon: <Refresh size={13} />,
          action: forceRefreshGitStatus,
        },
        {
          id: "open-folder",
          label: "Open folder",
          icon: <Folder size={13} />,
          separatorBefore: true,
          action: () =>
            void openArtifactLocation(selectedFolder, "folder").catch(
              () => undefined,
            ),
        },
      ],
      "Git",
    );
  }

  if (
    !currentStatus ||
    currentStatus.state !== "ready" ||
    !currentStatus.is_repo
  ) {
    const label =
      loading && !currentStatus
        ? "Checking Git..."
        : gitStateLabel(currentStatus);
    const stateClass = forceExpanded
      ? "git-panel git-panel-state git-panel-workspace git-panel-workspace-state"
      : `git-panel git-panel-collapsed git-panel-state${onOpenPanel ? " git-panel-launcher" : ""}`;
    return (
      <section
        className={stateClass}
        data-testid="git-panel"
        aria-label="Git environment"
        onContextMenu={openGitStateContextMenu}
      >
        <div
          className="git-panel-state-row"
          title={currentStatus?.message || selectedFolder}
        >
          <span className="git-panel-mark" aria-hidden="true">
            <GitLogo size={16} />
          </span>
          <strong className="git-panel-state-label">{label}</strong>
          <button
            type="button"
            className="git-icon-btn"
            data-testid="git-refresh"
            title="Refresh Git status"
            aria-label="Refresh Git status"
            onClick={forceRefreshGitStatus}
          >
            <Refresh size={13} />
          </button>
        </div>
      </section>
    );
  }

  const readyStatus = currentStatus;
  const changedFiles = changedFilesCount(readyStatus);
  const changeSummary = changeLabel(readyStatus);
  const filePreview = forceExpanded
    ? readyStatus.changed_files
    : readyStatus.changed_files.slice(0, FILE_PREVIEW_LIMIT);
  const moreFiles = Math.max(0, changedFiles - filePreview.length);
  const updated = updatedLabel(updatedAt, now);
  const remoteUrl = remoteWebUrl(readyStatus.remote);
  const sync = syncCommand(readyStatus);
  const SyncIcon =
    sync?.action === "pull"
      ? Download
      : sync?.action === "push"
        ? ArrowUp
        : GitBranch;
  const commandOutput = commandResult ? actionOutputText(commandResult) : "";
  const diffOutput = diffResult ? actionOutputText(diffResult) : "";
  const renderedDiffRows = diffOutput ? diffRows(diffOutput) : [];
  const renderedDiffSections = renderedDiffRows.length
    ? diffSections(renderedDiffRows)
    : [];
  const renderedDiffStats = renderedDiffRows.length
    ? diffStats(renderedDiffRows)
    : { files: 0, additions: 0, deletions: 0 };
  const normalizedDiffSearch = diffSearch.trim().toLowerCase();
  const visibleDiffRows: {
    row: DiffRow;
    index: number;
    section: DiffSection | null;
    sectionIndex: number;
  }[] = [];
  let currentSectionIndex = -1;
  for (let index = 0; index < renderedDiffRows.length; index += 1) {
    if (renderedDiffSections[currentSectionIndex + 1]?.start === index)
      currentSectionIndex += 1;
    const section =
      currentSectionIndex >= 0
        ? renderedDiffSections[currentSectionIndex]
        : null;
    if (
      section &&
      collapsedDiffSections.has(section.id) &&
      renderedDiffRows[index].kind !== "file"
    )
      continue;
    visibleDiffRows.push({
      row: renderedDiffRows[index],
      index,
      section,
      sectionIndex: currentSectionIndex,
    });
  }
  const diffSearchMatches = normalizedDiffSearch
    ? visibleDiffRows
        .filter(({ row }) =>
          row.text.toLowerCase().includes(normalizedDiffSearch),
        )
        .map(({ index }) => index)
    : [];
  const activeDiffSearchIndex = diffSearchMatches.length
    ? Math.min(diffSearchIndex, diffSearchMatches.length - 1)
    : 0;
  const diffSearchMatchIndexByRow = new Map(
    diffSearchMatches.map((rowIndex, matchIndex) => [rowIndex, matchIndex]),
  );
  const commitReady = stageAll || readyStatus.staged > 0;
  const canCommitPush = Boolean(
    readyStatus.remote && readyStatus.branch && readyStatus.behind === 0,
  );
  const normalizedBranchFilter = branchFilter.trim().toLowerCase();
  const branches = readyStatus.branches ?? [];
  const filteredBranches = normalizedBranchFilter
    ? branches.filter(
        (branch) =>
          branch.name.toLowerCase().includes(normalizedBranchFilter) ||
          branch.upstream?.toLowerCase().includes(normalizedBranchFilter),
      )
    : branches;
  const nextBranchName = newBranchName.trim();
  const canCreateBranch =
    Boolean(nextBranchName) &&
    !branches.some((branch) => branch.name === nextBranchName);

  async function copyBranch() {
    try {
      await navigator.clipboard?.writeText(branchLabel(readyStatus));
    } catch {
      // Clipboard access can be unavailable in web previews.
    }
    setNotice("Branch copied");
  }

  async function openFolder() {
    await openArtifactLocation(
      readyStatus.root || selectedFolder,
      "folder",
    ).catch(() => undefined);
  }

  async function openRemote() {
    if (!remoteUrl) return;
    await openExternalUrl(remoteUrl).catch(() =>
      setNotice("Couldn't open remote"),
    );
  }

  function openGitContextMenu(event: ReactMouseEvent) {
    openContextMenu(
      event,
      [
        {
          id: "refresh",
          label: "Refresh",
          icon: <Refresh size={13} />,
          action: forceRefreshGitStatus,
        },
        {
          id: "copy-branch",
          label: "Copy branch",
          detail: branchLabel(readyStatus),
          icon: <Copy size={13} />,
          action: () => void copyBranch(),
        },
        {
          id: "branch",
          label: "Switch or create branch",
          icon: <GitBranch size={13} />,
          action: () => {
            setNotice(null);
            setBranchMenuOpen(true);
          },
        },
        {
          id: "open-folder",
          label: "Open folder",
          icon: <Folder size={13} />,
          separatorBefore: true,
          action: () => void openFolder(),
        },
        {
          id: "open-remote",
          label: "Open remote",
          icon: <GitRemote size={13} />,
          disabled: !remoteUrl,
          action: () => void openRemote(),
        },
        {
          id: "diff",
          label: "Diff",
          icon: <Code size={13} />,
          disabled: !readyStatus.has_changes || Boolean(commandBusy),
          separatorBefore: true,
          action: () => void runGitCommand("diff"),
        },
        {
          id: "fetch",
          label: "Fetch",
          icon: <GitRemote size={13} />,
          disabled: !readyStatus.remote || Boolean(commandBusy),
          action: () => void runGitCommand("fetch"),
        },
        {
          id: "commit",
          label: "Commit",
          icon: <GitCommit size={13} />,
          disabled:
            !readyStatus.has_changes ||
            readyStatus.conflicts > 0 ||
            Boolean(commandBusy),
          action: () => openCommandMenu("commit"),
        },
        ...(sync
          ? [
              {
                id: "sync",
                label: sync.label,
                icon: <SyncIcon size={13} />,
                disabled: sync.disabled || Boolean(commandBusy),
                action: () => openCommandMenu(sync.action),
              },
            ]
          : []),
        {
          id: "agent-review",
          label: "Ask agent to review",
          icon: <Lightbulb size={13} />,
          separatorBefore: true,
          action: () =>
            onDraftAction(agentReviewPrompt(selectedFolder, readyStatus)),
        },
      ],
      "Git",
    );
  }

  function scrollToDiffSection(sectionIndex: number) {
    window.setTimeout(() => {
      diffViewRef.current
        ?.querySelector(`[data-section-index="${sectionIndex}"]`)
        ?.scrollIntoView({ block: "start" });
    }, 0);
  }

  function toggleDiffSection(sectionId: string) {
    setCollapsedDiffSections((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) next.delete(sectionId);
      else next.add(sectionId);
      return next;
    });
    setDiffSearchIndex(0);
  }

  function stepDiffSearch(delta: number) {
    if (!diffSearchMatches.length) return;
    setDiffSearchIndex(
      (activeDiffSearchIndex + delta + diffSearchMatches.length) %
        diffSearchMatches.length,
    );
  }

  function renderDiffToolbar() {
    return (
      <div className="git-diff-toolbar">
        <div className="git-diff-stats" aria-label="Diff summary">
          <span>{renderedDiffStats.files} files</span>
          <span className="add">+{renderedDiffStats.additions}</span>
          <span className="delete">-{renderedDiffStats.deletions}</span>
          <span>Worktree</span>
        </div>
        <label className="git-diff-search">
          <Search size={12} />
          <input
            value={diffSearch}
            placeholder="Search diff"
            onChange={(event) => {
              setDiffSearch(event.currentTarget.value);
              setDiffSearchIndex(0);
            }}
          />
          <span>
            {diffSearchMatches.length
              ? `${activeDiffSearchIndex + 1}/${diffSearchMatches.length}`
              : "0/0"}
          </span>
          <button
            type="button"
            disabled={!diffSearchMatches.length}
            onClick={() => stepDiffSearch(-1)}
          >
            Prev
          </button>
          <button
            type="button"
            disabled={!diffSearchMatches.length}
            onClick={() => stepDiffSearch(1)}
          >
            Next
          </button>
        </label>
      </div>
    );
  }

  function renderDiffFileTabs() {
    if (!renderedDiffSections.length) return null;
    return (
      <div className="git-diff-file-rail">
        <div className="git-diff-file-tabs" aria-label="Changed files">
          {renderedDiffSections.map((section) => {
            const sectionIndex = renderedDiffSections.indexOf(section);
            const collapsed = collapsedDiffSections.has(section.id);
            return (
              <button
                className={collapsed ? "collapsed" : ""}
                type="button"
                key={section.id}
                title={section.path}
                onClick={() => scrollToDiffSection(sectionIndex)}
              >
                <span>{compactPath(section.path)}</span>
                <small>
                  +{section.additions}/-{section.deletions}
                </small>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  function renderDiffView() {
    return (
      <div
        className="git-diff-view"
        role="table"
        aria-label="Unified diff"
        ref={diffViewRef}
      >
        {visibleDiffRows.map(({ row, index, section, sectionIndex }) => {
          const collapsed = section
            ? collapsedDiffSections.has(section.id)
            : false;
          const matchIndex = diffSearchMatchIndexByRow.get(index);
          const searchActive =
            matchIndex === activeDiffSearchIndex &&
            diffSearchMatches.length > 0;
          return (
            <div
              className={`git-diff-row ${row.kind}${searchActive ? " search-active" : ""}`}
              role="row"
              key={`${index}:${row.kind}:${row.oldNo}:${row.newNo}`}
              data-section-index={
                row.kind === "file" ? sectionIndex : undefined
              }
              data-match-index={matchIndex}
            >
              <span
                className="git-diff-gutter old"
                aria-label={row.oldNo ? `Old line ${row.oldNo}` : undefined}
              >
                {row.oldNo}
              </span>
              <span
                className="git-diff-gutter new"
                aria-label={row.newNo ? `New line ${row.newNo}` : undefined}
              >
                {row.newNo}
              </span>
              <span className="git-diff-marker" aria-hidden="true">
                {row.marker}
              </span>
              {row.kind === "file" && section ? (
                <button
                  className="git-diff-file-toggle"
                  type="button"
                  onClick={() => toggleDiffSection(section.id)}
                >
                  <span>{row.text}</span>
                  <small>
                    +{section.additions}/-{section.deletions} ֲ·{" "}
                    {section.lineCount} lines ֲ·{" "}
                    {collapsed ? "Expand" : "Collapse"}
                  </small>
                </button>
              ) : (
                <code>
                  {renderDiffText(row, index, renderedDiffRows, diffSearch)}
                </code>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  function renderDiffContent(inline = false) {
    if (!visibleDiffRows.length)
      return <div className="git-diff-empty">No diff output.</div>;
    if (inline) {
      return (
        <>
          {renderDiffToolbar()}
          {renderDiffView()}
        </>
      );
    }
    return (
      <>
        {renderDiffToolbar()}
        {renderDiffFileTabs()}
        {renderDiffView()}
      </>
    );
  }

  async function runGitCommand(
    action: WorkspaceGitAction,
    options: { message?: string; stage_all?: boolean; branch?: string } = {},
  ) {
    if (commandBusy) return;

    setCommandBusy(action);
    setCommandMenu(null);
    setNotice(null);
    try {
      const result = await runWorkspaceGitAction(action, options);
      if (action === "diff") {
        setDiffResult(result);
        setCommandResult(null);
      } else {
        setCommandResult(result);
        if (result.ok && (action === "commit" || action === "commit_push")) {
          setCommitMessage("");
          setStageAll(true);
        }
        if (action === "checkout_branch" || action === "create_branch") {
          setNotice(result.ok ? null : result.message);
          if (result.ok) {
            setBranchMenuOpen(false);
            setBranchFilter("");
            setNewBranchName("");
          }
        }
        forceRefreshGitStatus();
      }
    } catch (error) {
      if (action === "diff") setDiffResult(null);
      else setCommandResult(null);
      setNotice(error instanceof Error ? error.message : "Git command failed");
    } finally {
      setCommandBusy(null);
    }
  }

  function openCommandMenu(action: WorkspaceGitAction) {
    if (commandBusy) return;
    setCommandMenu((current) => (current === action ? null : action));
    setNotice(null);
  }

  async function runCommit(push: boolean) {
    let message = commitMessage.trim();
    if (!message) {
      setGeneratingCommitMessage(true);
      setNotice(null);
      try {
        const diff = await runWorkspaceGitAction("diff", {
          staged_only: !stageAll,
        });
        const output = actionOutputText(diff);
        if (!output.trim()) {
          setNotice("No diff available for a commit message.");
          return;
        }
        message = await generateCommitMessageWithFallback(
          model,
          selectedFolder,
          readyStatus,
          output,
        );
        setCommitMessage(message);
      } catch (error) {
        setNotice(
          error instanceof Error
            ? error.message
            : "Couldn't generate a commit message.",
        );
        return;
      } finally {
        setGeneratingCommitMessage(false);
      }
    }
    void runGitCommand(push ? "commit_push" : "commit", {
      message,
      stage_all: stageAll,
    });
  }

  if (!expanded) {
    return (
      <section
        className={`git-panel git-panel-collapsed${onOpenPanel ? " git-panel-launcher" : ""}`}
        data-testid="git-panel"
        aria-label="Git environment"
      >
        <div className="git-panel-collapsed-row">
          <button
            type="button"
            className="git-panel-toggle"
            data-testid="git-panel-toggle"
            aria-expanded={false}
            title={`${onOpenPanel ? "Open" : "Expand"} Git panel for ${repoName}`}
            onClick={() => (onOpenPanel ? onOpenPanel() : setExpanded(true))}
          >
            <span className="git-panel-mark" aria-hidden="true">
              <GitLogo size={16} />
            </span>
            <span className="git-panel-toggle-copy">
              <strong>{repoName}</strong>
              <span>{branchLabel(readyStatus)}</span>
            </span>
            <span
              className={`git-panel-toggle-stat ${changeTone(readyStatus)}`}
            >
              {compactChangeLabel(readyStatus)}
            </span>
            <ChevronDown size={13} className="git-panel-chevron" />
          </button>
          <button
            type="button"
            className="git-icon-btn"
            data-testid="git-refresh"
            title="Refresh Git status"
            aria-label="Refresh Git status"
            onClick={forceRefreshGitStatus}
          >
            <Refresh size={13} />
          </button>
        </div>
      </section>
    );
  }

  return (
    <>
      <section
        className={`git-panel${forceExpanded ? " git-panel-workspace" : ""}`}
        data-testid="git-panel"
        aria-label="Git environment"
        onContextMenu={openGitContextMenu}
      >
        <div className="git-panel-head">
          <button
            type="button"
            className="git-panel-title"
            data-testid="git-panel-toggle"
            aria-expanded={true}
            title={`${forceExpanded ? "Git panel" : "Collapse Git panel"} for ${repoName}`}
            onClick={() => {
              if (!forceExpanded) setExpanded(false);
            }}
          >
            <span className="git-panel-mark" aria-hidden="true">
              <GitLogo size={16} />
            </span>
            <span className="git-panel-title-copy">
              <strong title={readyStatus.root || selectedFolder}>
                {repoName}
              </strong>
            </span>
            <ChevronDown size={13} className="git-panel-chevron expanded" />
          </button>
          <button
            type="button"
            className="git-icon-btn"
            data-testid="git-refresh"
            title="Refresh Git status"
            aria-label="Refresh Git status"
            onClick={forceRefreshGitStatus}
          >
            <Refresh size={13} />
          </button>
        </div>

        <div className="git-panel-subhead">
          <button
            className="git-branch-chip"
            type="button"
            data-testid={
              forceExpanded ? "git-branch-selector" : "git-copy-branch"
            }
            onClick={() => {
              if (!forceExpanded) {
                void copyBranch();
                return;
              }
              setNotice(null);
              setBranchMenuOpen(true);
            }}
            title={forceExpanded ? "Switch or create branch" : "Copy branch"}
          >
            <GitBranch size={12} />
            <span>{branchLabel(readyStatus)}</span>
            {forceExpanded ? <ChevronDown size={11} /> : <Copy size={11} />}
          </button>
          {updated && <span className="git-panel-updated">{updated}</span>}
        </div>

        <div
          className={`git-summary ${changeTone(readyStatus)}`}
          data-testid="git-changes-row"
        >
          <span className="git-summary-main">
            <GitCommit size={14} />
            <strong title={changeSummary}>{changeSummary}</strong>
          </span>
          {diffLabel(readyStatus) && (
            <span className="git-summary-diff">
              {renderDiffStat(readyStatus)}
            </span>
          )}
        </div>

        {filePreview.length > 0 && (
          <div className="git-file-list" aria-label="Changed files">
            {filePreview.map((change) => (
              <div
                className="git-file-row"
                key={`${change.status}:${change.path}`}
                title={changedFileTitle(change)}
              >
                <span className="git-file-status">
                  {gitStatusLabel(change.status)}
                </span>
                <span className="git-file-path">
                  {compactPath(cleanGitPath(change.path))}
                </span>
              </div>
            ))}
            {moreFiles > 0 && (
              <div className="git-file-more">+{moreFiles} more</div>
            )}
          </div>
        )}

        <div className="git-panel-details">
          <button
            className="git-row"
            type="button"
            onClick={openFolder}
            title={readyStatus.root || selectedFolder}
          >
            <Folder size={14} />
            <span className="git-row-label">Local</span>
            <span className="git-row-value">
              {compactPath(readyStatus.root || selectedFolder)}
            </span>
          </button>

          {remoteUrl ? (
            <button
              className="git-row"
              type="button"
              onClick={openRemote}
              title={remoteUrl}
            >
              <GitRemote size={14} />
              <span className="git-row-label">Remote</span>
              <span className="git-row-value">{syncLabel(readyStatus)}</span>
            </button>
          ) : (
            <div
              className="git-row git-row-static"
              title={readyStatus.upstream || readyStatus.remote || undefined}
            >
              <GitRemote size={14} />
              <span className="git-row-label">Remote</span>
              <span className="git-row-value">{syncLabel(readyStatus)}</span>
            </div>
          )}
        </div>

        <div
          className="git-panel-actions git-command-actions"
          aria-label="Git commands"
        >
          {(!forceExpanded || readyStatus.has_changes) && (
            <button
              className="git-action"
              type="button"
              data-testid="git-action-diff"
              title={
                readyStatus.has_changes
                  ? "Open diff panel"
                  : "No changes to diff"
              }
              disabled={!readyStatus.has_changes || Boolean(commandBusy)}
              onClick={() => void runGitCommand("diff")}
            >
              <Code size={13} />
              <span>{commandBusy === "diff" ? "Diff..." : "Diff"}</span>
            </button>
          )}

          <button
            className="git-action"
            type="button"
            data-testid="git-action-fetch"
            title={
              readyStatus.remote
                ? "Run git fetch --prune"
                : "No remote configured"
            }
            disabled={!readyStatus.remote || Boolean(commandBusy)}
            onClick={() => void runGitCommand("fetch")}
          >
            <GitRemote size={13} />
            <span>{commandBusy === "fetch" ? "Fetch..." : "Fetch"}</span>
          </button>

          {(!forceExpanded || readyStatus.has_changes) && (
            <button
              className={`git-action ${commandMenu === "commit" ? "active" : ""}`}
              type="button"
              data-testid="git-action-commit"
              title={
                readyStatus.conflicts
                  ? "Resolve conflicts before committing"
                  : readyStatus.has_changes
                    ? "Open commit commands"
                    : "No changes to commit"
              }
              disabled={
                !readyStatus.has_changes ||
                readyStatus.conflicts > 0 ||
                Boolean(commandBusy)
              }
              onClick={() => openCommandMenu("commit")}
            >
              <GitCommit size={13} />
              <span>Commit</span>
            </button>
          )}

          {sync && (
            <button
              className={`git-action git-action-sync ${commandMenu === sync.action ? "active" : ""}`}
              type="button"
              data-testid="git-action-sync"
              title={sync.title}
              disabled={sync.disabled || Boolean(commandBusy)}
              onClick={() => openCommandMenu(sync.action)}
            >
              <SyncIcon size={13} />
              <span>
                {commandBusy === sync.action ? `${sync.label}...` : sync.label}
              </span>
            </button>
          )}

          {forceExpanded && commandResult && (
            <div
              className={`git-command-status ${commandResult.ok ? "" : "error"}`}
              role="status"
              title={
                commandOutput || commandResult.command || commandResult.message
              }
            >
              <span>{commandResult.message}</span>
            </div>
          )}
        </div>

        {!forceExpanded && commandResult && (
          <div
            className={`git-command-status ${commandResult.ok ? "" : "error"}`}
            role="status"
            title={
              commandOutput || commandResult.command || commandResult.message
            }
          >
            <span>{commandResult.message}</span>
          </div>
        )}

        {forceExpanded && !readyStatus.has_changes && (
          <div className="git-panel-clean-state" role="status">
            <GitCommit size={18} />
            <strong>No changes to review</strong>
            <span>Working tree is clean on {branchLabel(readyStatus)}.</span>
          </div>
        )}

        <button
          className="git-agent-action"
          type="button"
          onClick={() =>
            onDraftAction(agentReviewPrompt(selectedFolder, readyStatus))
          }
        >
          <Lightbulb size={13} />
          <span>Ask agent to review</span>
        </button>

        {notice && (
          <div className="git-panel-note" role="status">
            {notice}
          </div>
        )}

        {forceExpanded && diffResult && (
          <section
            className={`git-workspace-review ${diffResult.ok ? "" : "error"}`}
            aria-label="Git diff"
          >
            <div className="git-modal-head">
              <span>
                <Code size={13} />
                <strong>{diffResult.message}</strong>
              </span>
              <button
                type="button"
                className="git-icon-btn"
                title="Close diff"
                aria-label="Close diff"
                onClick={() => setDiffResult(null)}
              >
                <X size={13} />
              </button>
            </div>
            {diffResult.command && (
              <code className="git-command-preview">{diffResult.command}</code>
            )}
            {renderDiffContent(true)}
          </section>
        )}
      </section>
      {typeof document !== "undefined" &&
        branchMenuOpen &&
        createPortal(
          <div
            className="git-modal-backdrop"
            onMouseDown={(event) =>
              event.target === event.currentTarget && setBranchMenuOpen(false)
            }
          >
            <section
              className="git-modal git-branch-modal"
              role="dialog"
              aria-modal="true"
              aria-label="Switch branch"
            >
              <div className="git-modal-head">
                <span>
                  <GitBranch size={13} />
                  <strong>Branch</strong>
                </span>
                <button
                  type="button"
                  className="git-icon-btn"
                  title="Close"
                  aria-label="Close"
                  onClick={() => setBranchMenuOpen(false)}
                >
                  <X size={13} />
                </button>
              </div>
              <label className="git-branch-search">
                <Search size={12} />
                <input
                  value={branchFilter}
                  placeholder="Search branches..."
                  onChange={(event) =>
                    setBranchFilter(event.currentTarget.value)
                  }
                />
              </label>
              <div className="git-branch-list" aria-label="Local branches">
                {filteredBranches.length ? (
                  filteredBranches.map((branch) => (
                    <button
                      type="button"
                      className={branch.current ? "active" : ""}
                      key={branch.name}
                      disabled={branch.current || Boolean(commandBusy)}
                      onClick={() =>
                        void runGitCommand("checkout_branch", {
                          branch: branch.name,
                        })
                      }
                      title={branch.name}
                    >
                      <span>
                        <GitBranch size={12} />
                        <strong>{branch.name}</strong>
                      </span>
                      <small>{branchMetaLabel(branch)}</small>
                    </button>
                  ))
                ) : (
                  <div className="git-branch-empty">No branches found.</div>
                )}
              </div>
              <div className="git-branch-create">
                <input
                  type="text"
                  value={newBranchName}
                  placeholder="New branch from HEAD"
                  disabled={Boolean(commandBusy)}
                  onChange={(event) =>
                    setNewBranchName(event.currentTarget.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && canCreateBranch)
                      void runGitCommand("create_branch", {
                        branch: nextBranchName,
                      });
                  }}
                />
                <button
                  type="button"
                  disabled={!canCreateBranch || Boolean(commandBusy)}
                  onClick={() =>
                    void runGitCommand("create_branch", {
                      branch: nextBranchName,
                    })
                  }
                >
                  <GitBranch size={12} />
                  <span>
                    {commandBusy === "create_branch" ? "Creating..." : "Create"}
                  </span>
                </button>
              </div>
              {notice && (
                <div className="git-command-modal-note" role="status">
                  {notice}
                </div>
              )}
            </section>
          </div>,
          document.body,
        )}
      {typeof document !== "undefined" &&
        commandMenu &&
        createPortal(
          <div
            className="git-modal-backdrop"
            onMouseDown={(event) =>
              event.target === event.currentTarget && setCommandMenu(null)
            }
          >
            <section
              className="git-modal git-command-modal"
              role="dialog"
              aria-modal="true"
              aria-label={`${actionLabel(commandMenu)} command`}
            >
              <div className="git-modal-head">
                <span>
                  <GitBranch size={13} />
                  <strong>{actionLabel(commandMenu)}</strong>
                </span>
                <button
                  type="button"
                  className="git-icon-btn"
                  title="Close"
                  aria-label="Close"
                  onClick={() => setCommandMenu(null)}
                >
                  <X size={13} />
                </button>
              </div>
              <div className="git-command-modal-meta">
                <span>{branchLabel(readyStatus)}</span>
                <strong>{renderDiffStat(readyStatus) || changeSummary}</strong>
              </div>

              {commandMenu === "commit" ? (
                <>
                  <input
                    className="git-commit-input"
                    type="text"
                    value={commitMessage}
                    placeholder="Commit message (blank generates)"
                    disabled={Boolean(commandBusy) || generatingCommitMessage}
                    onChange={(event) =>
                      setCommitMessage(event.currentTarget.value)
                    }
                  />
                  <label className="git-check-row">
                    <input
                      type="checkbox"
                      checked={stageAll}
                      disabled={Boolean(commandBusy) || generatingCommitMessage}
                      onChange={(event) =>
                        setStageAll(event.currentTarget.checked)
                      }
                    />
                    <span>Include unstaged changes</span>
                  </label>
                  <code className="git-command-preview">
                    {commandPreview(
                      "commit",
                      readyStatus,
                      commitMessage,
                      stageAll,
                    )}
                  </code>
                  {notice && (
                    <div className="git-command-modal-note" role="status">
                      {notice}
                    </div>
                  )}
                  <div className="git-command-options">
                    <button
                      type="button"
                      disabled={
                        !commitReady ||
                        Boolean(commandBusy) ||
                        generatingCommitMessage
                      }
                      onClick={() => void runCommit(false)}
                    >
                      <GitCommit size={13} />
                      <span>
                        {generatingCommitMessage
                          ? "Generating..."
                          : commandBusy === "commit"
                            ? "Committing..."
                            : "Commit"}
                      </span>
                    </button>
                    <button
                      type="button"
                      disabled={
                        !commitReady ||
                        !canCommitPush ||
                        Boolean(commandBusy) ||
                        generatingCommitMessage
                      }
                      title={
                        canCommitPush
                          ? "Commit, then push"
                          : "Remote branch required and not behind"
                      }
                      onClick={() => void runCommit(true)}
                    >
                      <ArrowUp size={13} />
                      <span>
                        {generatingCommitMessage
                          ? "Generating..."
                          : commandBusy === "commit_push"
                            ? "Pushing..."
                            : "Commit and push"}
                      </span>
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <code className="git-command-preview">
                    {commandPreview(
                      commandMenu,
                      readyStatus,
                      commitMessage,
                      stageAll,
                    )}
                  </code>
                  <div className="git-command-options">
                    <button
                      type="button"
                      disabled={Boolean(commandBusy)}
                      onClick={() => void runGitCommand(commandMenu)}
                    >
                      {commandMenu === "pull" ? (
                        <Download size={13} />
                      ) : commandMenu === "push" ? (
                        <ArrowUp size={13} />
                      ) : (
                        <GitBranch size={13} />
                      )}
                      <span>
                        {commandBusy === commandMenu
                          ? `${actionLabel(commandMenu)}...`
                          : `Run ${actionLabel(commandMenu)}`}
                      </span>
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>,
          document.body,
        )}
      {typeof document !== "undefined" &&
        diffResult &&
        !forceExpanded &&
        createPortal(
          <div
            className="git-modal-backdrop"
            onMouseDown={(event) =>
              event.target === event.currentTarget && setDiffResult(null)
            }
          >
            <section
              className={`git-modal git-diff-panel ${diffResult.ok ? "" : "error"}`}
              role="dialog"
              aria-modal="true"
              aria-label="Git diff"
            >
              <div className="git-modal-head">
                <span>
                  <Code size={13} />
                  <strong>{diffResult.message}</strong>
                </span>
                <button
                  type="button"
                  className="git-icon-btn"
                  title="Close diff"
                  aria-label="Close diff"
                  onClick={() => setDiffResult(null)}
                >
                  <X size={13} />
                </button>
              </div>
              {diffResult.command && (
                <code className="git-command-preview">
                  {diffResult.command}
                </code>
              )}
              {visibleDiffRows.length > 0 ? (
                <>
                  <div className="git-diff-toolbar">
                    <div className="git-diff-stats" aria-label="Diff summary">
                      <span>{renderedDiffStats.files} files</span>
                      <span className="add">
                        +{renderedDiffStats.additions}
                      </span>
                      <span className="delete">
                        -{renderedDiffStats.deletions}
                      </span>
                      <span>Worktree</span>
                    </div>
                    <label className="git-diff-search">
                      <Search size={12} />
                      <input
                        value={diffSearch}
                        placeholder="Search diff"
                        onChange={(event) => {
                          setDiffSearch(event.currentTarget.value);
                          setDiffSearchIndex(0);
                        }}
                      />
                      <span>
                        {diffSearchMatches.length
                          ? `${activeDiffSearchIndex + 1}/${diffSearchMatches.length}`
                          : "0/0"}
                      </span>
                      <button
                        type="button"
                        disabled={!diffSearchMatches.length}
                        onClick={() => stepDiffSearch(-1)}
                      >
                        Prev
                      </button>
                      <button
                        type="button"
                        disabled={!diffSearchMatches.length}
                        onClick={() => stepDiffSearch(1)}
                      >
                        Next
                      </button>
                    </label>
                  </div>

                  {renderedDiffSections.length > 0 && (
                    <div
                      className="git-diff-file-tabs"
                      aria-label="Changed files"
                    >
                      {renderedDiffSections.map((section, sectionIndex) => {
                        const collapsed = collapsedDiffSections.has(section.id);
                        return (
                          <button
                            className={collapsed ? "collapsed" : ""}
                            type="button"
                            key={section.id}
                            title={section.path}
                            onClick={() => scrollToDiffSection(sectionIndex)}
                          >
                            <span>{compactPath(section.path)}</span>
                            <small>
                              +{section.additions}/-{section.deletions}
                            </small>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  <div
                    className="git-diff-view"
                    role="table"
                    aria-label="Unified diff"
                    ref={diffViewRef}
                  >
                    {visibleDiffRows.map(
                      ({ row, index, section, sectionIndex }) => {
                        const collapsed = section
                          ? collapsedDiffSections.has(section.id)
                          : false;
                        const matchIndex = diffSearchMatchIndexByRow.get(index);
                        const searchActive =
                          matchIndex === activeDiffSearchIndex &&
                          diffSearchMatches.length > 0;
                        return (
                          <div
                            className={`git-diff-row ${row.kind}${searchActive ? " search-active" : ""}`}
                            role="row"
                            key={`${index}:${row.kind}:${row.oldNo}:${row.newNo}`}
                            data-section-index={
                              row.kind === "file" ? sectionIndex : undefined
                            }
                            data-match-index={matchIndex}
                          >
                            <span
                              className="git-diff-gutter old"
                              aria-label={
                                row.oldNo ? `Old line ${row.oldNo}` : undefined
                              }
                            >
                              {row.oldNo}
                            </span>
                            <span
                              className="git-diff-gutter new"
                              aria-label={
                                row.newNo ? `New line ${row.newNo}` : undefined
                              }
                            >
                              {row.newNo}
                            </span>
                            <span
                              className="git-diff-marker"
                              aria-hidden="true"
                            >
                              {row.marker}
                            </span>
                            {row.kind === "file" && section ? (
                              <button
                                className="git-diff-file-toggle"
                                type="button"
                                onClick={() => toggleDiffSection(section.id)}
                              >
                                <span>{row.text}</span>
                                <small>
                                  +{section.additions}/-{section.deletions} ·{" "}
                                  {section.lineCount} lines ·{" "}
                                  {collapsed ? "Expand" : "Collapse"}
                                </small>
                              </button>
                            ) : (
                              <code>
                                {renderDiffText(
                                  row,
                                  index,
                                  renderedDiffRows,
                                  diffSearch,
                                )}
                              </code>
                            )}
                          </div>
                        );
                      },
                    )}
                  </div>
                </>
              ) : (
                <div className="git-diff-empty">No diff output.</div>
              )}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}

export function GitWorkspacePanel({
  folder,
  model,
  onDraftAction,
  closing = false,
  noEnterMotion = false,
  onClose,
  modeSwitcher,
  style,
}: {
  folder: string;
  model: string;
  onDraftAction: (text: string) => void;
  closing?: boolean;
  noEnterMotion?: boolean;
  onClose: () => void;
  modeSwitcher?: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <aside
      className={`preview-panel git-workspace-panel${closing ? " closing" : ""}${noEnterMotion ? " no-enter" : ""}`}
      data-testid="git-workspace-panel"
      style={style}
    >
      <div className="preview-toolbar git-workspace-toolbar">
        {modeSwitcher}
        <div className="preview-actions" aria-label="Git panel actions">
          <button
            className="preview-action"
            title="Close Git panel"
            aria-label="Close Git panel"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="git-workspace-scroll">
        <GitPanel
          folder={folder}
          model={model}
          onDraftAction={onDraftAction}
          forceExpanded
        />
      </div>
    </aside>
  );
}
