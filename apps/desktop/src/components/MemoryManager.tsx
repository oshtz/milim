import { useEffect, useMemo, useState } from "react";
import {
  archiveMemoryNode,
  deleteMemoryNode,
  listMemoryNodes,
  registerGraphMemory,
  searchGraphMemory,
  updateMemoryNode,
  wireMessageContent,
  type MemoryNode,
  type MemoryScopeKind,
  type MemoryScopeRef,
} from "../api";
import { DEFAULT_THREAD_SETTINGS, useSessions } from "../sessions/store";
import { Archive, Check, MoreHorizontal, Pencil, Plus, Refresh, Search, Trash, X } from "./icons";
import { SheetDialog } from "./SheetDialog";
import { Slider } from "./ui";
import "./MemoryManager.css";

type MemoryScopeChoice = "thread" | "project";
type MemoryTab = MemoryScopeChoice | "all";
type DetailMode = "view" | "edit" | "create";
type MemoryStatusFilter = "all" | "recent" | "weak" | "stale";
type MemorySort = "recall" | "updated" | "confidence" | "scope" | "kind";

interface MemoryDraft {
  kind: string;
  title: string;
  body: string;
  source: string;
  confidence: number;
  scope: MemoryScopeChoice;
}

const RECENT_DAYS = 14;
const STALE_DAYS = 45;
const NEXT_RUN_LIMIT = 5;

const DATE_TIME_FORMAT = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const COMPACT_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function projectLabel(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() || folder || "Project";
}

function scopeFor(tab: MemoryTab, threadId: string, threadTitle: string, folder: string): { kind: MemoryScopeKind; label: string; locator: string } | null {
  if (tab === "thread") return { kind: "thread", label: threadTitle || "Current thread", locator: threadId };
  if (tab === "project" && folder.trim()) return { kind: "project", label: projectLabel(folder), locator: folder.trim() };
  return null;
}

function nodeTitle(node: MemoryNode): string {
  return node.title.trim() || "Untitled memory";
}

function nodePreview(node: MemoryNode): string {
  return node.body.trim() || node.title.trim() || "No body yet.";
}

function isArchived(node: MemoryNode): boolean {
  return Boolean(node.archived_at);
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function confidencePercent(value: number): number {
  return Math.round(clampConfidence(value) * 100);
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : DATE_TIME_FORMAT.format(date);
}

function formatCompactDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : COMPACT_DATE_FORMAT.format(date);
}

function graphTime(node: MemoryNode): number {
  const value = Date.parse(node.updated_at);
  return Number.isFinite(value) ? value : 0;
}

function ageDays(node: MemoryNode): number {
  const updated = graphTime(node);
  if (!updated) return 0;
  return (Date.now() - updated) / 86_400_000;
}

function scopeKindLabel(kind: MemoryScopeKind): string {
  if (kind === "thread") return "Thread";
  if (kind === "project") return "Project";
  return "Global";
}

function scopeChipLabel(node: MemoryNode): string {
  const label = node.scope_label.trim();
  return label ? `${scopeKindLabel(node.scope_kind)}: ${label}` : scopeKindLabel(node.scope_kind);
}

function scopeSummary(tab: MemoryTab, threadTitle: string, folder: string): string {
  if (tab === "thread") return `Thread memory for ${threadTitle || "Current thread"}`;
  if (tab === "project" && folder.trim()) return `Project memory for ${projectLabel(folder)}`;
  if (tab === "project") return "Project memory needs a working folder";
  return "All thread, project, and global memories";
}

function emptyState(tab: MemoryTab, searchQuery: string | null, canUseProject: boolean): { title: string; body: string } {
  if (searchQuery) {
    return {
      title: "No matches",
      body: "Clear search or try broader words.",
    };
  }
  if (tab === "thread") {
    return {
      title: "No thread memories yet",
      body: "Capture facts, preferences, or decisions that should stay with this conversation.",
    };
  }
  if (tab === "project") {
    return canUseProject
      ? {
          title: "No project memories yet",
          body: "Capture project-level knowledge that should follow this working folder.",
        }
      : {
          title: "Project memory unavailable",
          body: "Select a working folder before storing project memory.",
        };
  }
  return {
    title: "No memories stored",
    body: "Capture thread or project memory to build a local knowledge library.",
  };
}

function draftFromNode(node: MemoryNode): MemoryDraft {
  return {
    kind: node.kind,
    title: node.title,
    body: node.body,
    source: node.source,
    confidence: clampConfidence(node.confidence),
    scope: node.scope_kind === "project" ? "project" : "thread",
  };
}

function newDraft(scope: MemoryScopeChoice): MemoryDraft {
  return {
    kind: "fact",
    title: "",
    body: "",
    source: "user",
    confidence: 1,
    scope,
  };
}

function memoryLine(node: MemoryNode, index: number): string {
  const body = node.body.trim() ? `: ${node.body.trim()}` : "";
  return `${index + 1}. [${node.scope_kind}/${node.kind || "fact"}] ${nodeTitle(node)}${body}`;
}

function memoryPromptBlock(nodes: MemoryNode[]): string {
  if (nodes.length === 0) return "";
  return [
    "Relevant local memories for this turn:",
    ...nodes.map(memoryLine),
    "",
    "Use these memories as context. Do not mention them unless they directly matter.",
  ].join("\n");
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

export function MemoryManager({ onClose }: { onClose: () => void }) {
  const activeId = useSessions((s) => s.activeId);
  const session = useSessions((s) => s.sessions.find((x) => x.id === s.activeId));
  const settings = session?.settings ?? DEFAULT_THREAD_SETTINGS;
  const threadTitle = session?.title ?? "Current thread";
  const folder = settings.folder;
  const model = settings.model.trim();

  const [tab, setTab] = useState<MemoryTab>("thread");
  const [query, setQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [nodes, setNodes] = useState<MemoryNode[]>([]);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<DetailMode>("view");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [draft, setDraft] = useState<MemoryDraft>(() => newDraft("thread"));
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [statusFilter, setStatusFilter] = useState<MemoryStatusFilter>("all");
  const [kindFilter, setKindFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [sort, setSort] = useState<MemorySort>("recall");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const selected = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId]);
  const canUseProject = Boolean(folder.trim());
  const currentScope = scopeFor(tab, activeId, threadTitle, folder);
  const searchActive = searchQuery != null;
  const searchCountLabel = `${nodes.length} ${nodes.length === 1 ? "match" : "matches"}`;
  const canSaveCreate = draft.title.trim().length > 0 || draft.body.trim().length > 0;
  const canSaveEdit = Boolean(selected && draft.title.trim());
  const lastUserContent = useMemo(() => {
    const lastUser = [...(session?.messages ?? [])].reverse().find((message) => message.role === "user");
    return lastUser ? wireMessageContent(lastUser).trim() : "";
  }, [session?.messages]);

  const kindOptions = useMemo(() => uniqueSorted(nodes.map((node) => node.kind || "fact")), [nodes]);
  const sourceOptions = useMemo(() => uniqueSorted(nodes.map((node) => node.source || "user")), [nodes]);

  const filteredNodes = useMemo(() => {
    const filtered = nodes.filter((node) => {
      if (!includeArchived && isArchived(node)) return false;
      if (statusFilter === "recent" && ageDays(node) > RECENT_DAYS) return false;
      if (statusFilter === "weak" && clampConfidence(node.confidence) >= 0.65) return false;
      if (statusFilter === "stale" && ageDays(node) < STALE_DAYS) return false;
      if (kindFilter !== "all" && (node.kind || "fact") !== kindFilter) return false;
      if (sourceFilter !== "all" && (node.source || "user") !== sourceFilter) return false;
      return true;
    });
    return [...filtered].sort((a, b) => {
      if (sort === "recall" && searchActive) {
        const scoreDelta = (scores[b.id] ?? -1) - (scores[a.id] ?? -1);
        if (scoreDelta) return scoreDelta;
      }
      if (sort === "confidence") return clampConfidence(b.confidence) - clampConfidence(a.confidence) || graphTime(b) - graphTime(a);
      if (sort === "scope") return `${a.scope_kind}:${a.scope_label}`.localeCompare(`${b.scope_kind}:${b.scope_label}`) || graphTime(b) - graphTime(a);
      if (sort === "kind") return (a.kind || "fact").localeCompare(b.kind || "fact") || graphTime(b) - graphTime(a);
      return graphTime(b) - graphTime(a);
    });
  }, [includeArchived, kindFilter, nodes, scores, searchActive, sort, sourceFilter, statusFilter]);

  const nextRunNodes = useMemo(() => (searchActive ? nodes.filter((node) => !isArchived(node)).slice(0, NEXT_RUN_LIMIT) : []), [nodes, searchActive]);
  const nextRunIds = useMemo(() => new Set(nextRunNodes.map((node) => node.id)), [nextRunNodes]);
  const listEmpty = emptyState(tab, searchQuery, canUseProject);
  const promptPreview = memoryPromptBlock(nextRunNodes);

  useEffect(() => {
    if (tab === "project" && !canUseProject) setTab("thread");
    if (!canUseProject) {
      setDraft((current) => (current.scope === "project" ? { ...current, scope: "thread" } : current));
    }
  }, [canUseProject, tab]);

  useEffect(() => {
    void load({ tabOverride: tab });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, activeId, folder, includeArchived]);

  useEffect(() => {
    setConfirmDeleteId(null);
  }, [selectedId, mode]);

  function defaultDraftScope(): MemoryScopeChoice {
    return tab === "project" && canUseProject ? "project" : "thread";
  }

  function tabScope(nextTab: MemoryTab): MemoryScopeRef | undefined {
    const scope = scopeFor(nextTab, activeId, threadTitle, folder);
    return scope ? { kind: scope.kind, locator: scope.locator } : undefined;
  }

  async function load(options: { tabOverride?: MemoryTab; selectId?: string | null } = {}) {
    setBusy(true);
    setNote(null);
    try {
      const next = await listMemoryNodes({ scope: tabScope(options.tabOverride ?? tab), includeArchived, limit: 300 });
      setNodes(next);
      setScores({});
      setSearchQuery(null);
      setSelectedId((current) => {
        if (options.selectId && next.some((node) => node.id === options.selectId)) return options.selectId;
        if (current && next.some((node) => node.id === current)) return current;
        return next.find((node) => !isArchived(node))?.id ?? next[0]?.id ?? null;
      });
    } finally {
      setBusy(false);
    }
  }

  async function runSearch(queryOverride?: string) {
    const q = (queryOverride ?? query).trim();
    if (!q) {
      await load();
      return;
    }
    setQuery(q);
    setBusy(true);
    setNote(null);
    setMode("view");
    setStatusFilter("all");
    try {
      const scope = tabScope(tab);
      const scopes: MemoryScopeRef[] = scope ? [scope] : [];
      const hits = await searchGraphMemory(q, scopes, 50, model || undefined, includeArchived);
      setNodes(hits.map((hit) => hit.node));
      setScores(Object.fromEntries(hits.map((hit) => [hit.node.id, hit.score])));
      setSearchQuery(q);
      setSelectedId(hits.find((hit) => !isArchived(hit.node))?.node.id ?? hits[0]?.node.id ?? null);
    } finally {
      setBusy(false);
    }
  }

  async function clearSearch() {
    setQuery("");
    setMode("view");
    await load({ selectId: selectedId });
  }

  function changeTab(nextTab: MemoryTab) {
    if (nextTab === "project" && !canUseProject) return;
    setTab(nextTab);
    setQuery("");
    setSearchQuery(null);
    setMode("view");
    setNote(null);
    setKindFilter("all");
    setSourceFilter("all");
  }

  function selectNode(nodeId: string) {
    setSelectedId(nodeId);
    setMode("view");
    setNote(null);
  }

  function startCreate() {
    setSelectedId(null);
    setDraft(newDraft(defaultDraftScope()));
    setShowAdvanced(false);
    setMode("create");
    setNote(null);
  }

  function startEdit() {
    if (!selected) return;
    setDraft(draftFromNode(selected));
    setShowAdvanced(true);
    setMode("edit");
    setNote(null);
  }

  function updateDraft(patch: Partial<MemoryDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function addMemory() {
    const body = draft.body.trim();
    const title = draft.title.trim() || firstLine(body);
    if (!title && !body) return;
    const target = scopeFor(draft.scope, activeId, threadTitle, folder);
    if (!target) {
      setNote("Select a working folder before adding project memory.");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const saved = await registerGraphMemory({
        model: model || undefined,
        scope: target,
        node: {
          kind: draft.kind.trim() || "fact",
          title: title || "Memory",
          body,
          source: draft.source.trim() || "user",
          confidence: clampConfidence(draft.confidence),
        },
        event: { thread_id: activeId, summary: title || body },
      });
      if (!saved) {
        setNote("Failed to store memory.");
        return;
      }

      const nextTab: MemoryTab = tab === "all" ? "all" : draft.scope;
      if (nextTab !== tab) setTab(nextTab);
      setDraft(newDraft(defaultDraftScope()));
      setMode("view");
      await load({ tabOverride: nextTab, selectId: saved.node.id });
      setNote("Stored.");
    } finally {
      setBusy(false);
    }
  }

  async function saveSelected() {
    if (!selected) return;
    const title = draft.title.trim();
    if (!title) return;
    setBusy(true);
    setNote(null);
    try {
      const updated = await updateMemoryNode(
        selected.id,
        {
          kind: draft.kind.trim() || "fact",
          title,
          body: draft.body.trim(),
          confidence: clampConfidence(draft.confidence),
          source: draft.source.trim() || "user",
        },
        model || undefined,
      );
      if (updated) {
        setNodes((current) => current.map((node) => (node.id === updated.id ? updated : node)));
        setSelectedId(updated.id);
        setMode("view");
        setNote("Updated.");
      } else {
        setNote("Failed to update memory.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function archiveSelected() {
    if (!selected || isArchived(selected)) return;
    setBusy(true);
    setNote(null);
    try {
      const ok = await archiveMemoryNode(selected.id);
      if (!ok) {
        setNote("Failed to archive memory.");
        return;
      }
      const archivedAt = new Date().toISOString();
      const next = includeArchived
        ? nodes.map((node) => (node.id === selected.id ? { ...node, archived_at: archivedAt } : node))
        : nodes.filter((node) => node.id !== selected.id);
      setNodes(next);
      setSelectedId(includeArchived ? selected.id : next.find((node) => !isArchived(node))?.id ?? next[0]?.id ?? null);
      setMode("view");
      setNote("Archived.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    if (!selected) return;
    if (confirmDeleteId !== selected.id) {
      setConfirmDeleteId(selected.id);
      setNote(`Click Confirm delete to permanently remove "${nodeTitle(selected)}".`);
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const ok = await deleteMemoryNode(selected.id);
      if (ok) {
        const next = nodes.filter((node) => node.id !== selected.id);
        setNodes(next);
        setSelectedId(next.find((node) => !isArchived(node))?.id ?? next[0]?.id ?? null);
        setMode("view");
        setConfirmDeleteId(null);
        setNote("Deleted.");
      } else {
        setNote("Failed to delete memory.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <SheetDialog title="Memory" className="sheet mem-sheet" onClose={onClose}>
      <div className="sheet-header mem-sheet-header">
        <div>
          <span className="mem-eyebrow">Local context</span>
          <h2>Memory</h2>
          <p className="sheet-sub mem-subtitle">Inspect the local context the agent can retrieve, trust, and carry into the next run.</p>
        </div>
        <button className="icon-btn" type="button" onClick={onClose} title="Close" aria-label="Close memory manager">
          <X size={15} />
        </button>
      </div>

      <div className="mem-layout">
        <aside className="mem-rail" aria-label="Memory scopes">
          <div className="mem-rail-section">
            <button type="button" className={"mem-scope-card" + (tab === "thread" ? " active" : "")} onClick={() => changeTab("thread")}>
              <span>Thread</span>
              <strong>{threadTitle || "Current thread"}</strong>
            </button>
            <button
              type="button"
              className={"mem-scope-card" + (tab === "project" ? " active" : "")}
              onClick={() => changeTab("project")}
              disabled={!canUseProject}
              title={canUseProject ? "Show current project memory" : "Select a working folder to use project memory"}
            >
              <span>Project</span>
              <strong>{canUseProject ? projectLabel(folder) : "No folder"}</strong>
            </button>
            <button type="button" className={"mem-scope-card" + (tab === "all" ? " active" : "")} onClick={() => changeTab("all")}>
              <span>All scopes</span>
              <strong>Thread, project, global</strong>
            </button>
          </div>

          <p className="mem-rail-note">{scopeSummary(tab, threadTitle, folder)}</p>
          {!canUseProject && <p className="mem-rail-warning">Project memory unlocks after a working folder is selected.</p>}
        </aside>

        <main className="mem-browser" aria-label="Memory browser" aria-busy={busy}>
          <div className="mem-browser-top">
            <form
              className="mem-lens"
              onSubmit={(e) => {
                e.preventDefault();
                void runSearch();
              }}
            >
              <label className="mem-search-field">
                <Search size={14} />
                <input
                  className="css-input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search memories..."
                  aria-label="Search memories"
                />
              </label>
              <button className="btn-accent mem-action-btn" type="submit" disabled={busy}>
                <Search size={14} />
                Search
              </button>
            </form>

            <div className="mem-browser-actions">
              {lastUserContent && (
                <button className="btn-ghost mem-action-btn" type="button" disabled={busy} onClick={() => void runSearch(lastUserContent)}>
                  Current prompt
                </button>
              )}
              <button className="btn-ghost mem-action-btn" type="button" disabled={busy} onClick={() => void load()}>
                <Refresh size={14} />
                Refresh
              </button>
              <button className="btn-accent mem-action-btn" type="button" disabled={busy} onClick={startCreate}>
                <Plus size={14} />
                Capture
              </button>
            </div>
          </div>

          {searchActive && (
            <div className="mem-search-state" role="status">
              <span>
                {searchCountLabel} for <strong>&quot;{searchQuery}&quot;</strong> in {currentScope?.label ?? "all scopes"}.
                {" "}
                {nextRunNodes.length > 0 ? `${nextRunNodes.length} ready for the next prompt.` : "No active memories found."}
              </span>
              <button className="btn-ghost mem-clear-search" type="button" disabled={busy} onClick={() => void clearSearch()}>
                <X size={13} />
                Clear
              </button>
            </div>
          )}

          <div className="mem-filterbar" aria-label="Memory filters">
            {(["all", "recent", "weak", "stale"] as MemoryStatusFilter[]).map((filter) => (
              <button
                key={filter}
                type="button"
                className={statusFilter === filter ? "active" : ""}
                onClick={() => setStatusFilter(filter)}
                aria-pressed={statusFilter === filter}
              >
                {filter === "all" ? "All" : filter === "weak" ? "Low trust" : filter === "stale" ? "Older" : filter}
              </button>
            ))}
            <button
              type="button"
              className={includeArchived ? "active" : ""}
              disabled={busy}
              onClick={() => setIncludeArchived((value) => !value)}
              aria-pressed={includeArchived}
              aria-label={includeArchived ? "Hide archived memories" : "Show archived memories"}
            >
              Archived
            </button>
            <span className="mem-filter-spacer" />
            <select className="css-input mem-select" value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} aria-label="Filter by kind">
              <option value="all">Any kind</option>
              {kindOptions.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
            </select>
            <select className="css-input mem-select" value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)} aria-label="Filter by source">
              <option value="all">Any source</option>
              {sourceOptions.map((source) => <option key={source} value={source}>{source}</option>)}
            </select>
            <select className="css-input mem-select" value={sort} onChange={(e) => setSort(e.target.value as MemorySort)} aria-label="Sort memories">
              <option value="recall">Relevance</option>
              <option value="updated">Updated</option>
              <option value="confidence">Confidence</option>
              <option value="scope">Scope</option>
              <option value="kind">Kind</option>
            </select>
          </div>

          <section className="mem-stream" data-testid="memory-node-list" aria-label="Memory stream">
            {filteredNodes.length === 0 ? (
              <div className="mem-list-placeholder">
                <strong>{busy ? "Loading..." : searchActive ? "No matches" : "No memories"}</strong>
                {!busy && <span>{searchActive ? "Clear search or try broader words." : listEmpty.body}</span>}
              </div>
            ) : (
              filteredNodes.map((node) => {
                const included = nextRunIds.has(node.id);
                const archived = isArchived(node);
                return (
                  <button
                    key={node.id}
                    type="button"
                    className={"mem-node-row" + (node.id === selectedId ? " active" : "") + (included ? " included" : "") + (archived ? " archived" : "")}
                    onClick={() => selectNode(node.id)}
                    aria-pressed={node.id === selectedId}
                  >
                    <span className="mem-node-head">
                      <span className="mem-node-title">{nodeTitle(node)}</span>
                      <span className="mem-node-time" title={`Updated ${formatDate(node.updated_at)}`}>{formatCompactDate(node.updated_at)}</span>
                    </span>
                    <span className="mem-node-body">{nodePreview(node)}</span>
                    <span className="mem-node-meta">
                      {included && <span className="mem-chip next">next prompt</span>}
                      {archived && <span className="mem-chip archived">archived</span>}
                      <span className={"mem-chip scope " + node.scope_kind} title={scopeChipLabel(node)}>{scopeChipLabel(node)}</span>
                      <span className="mem-chip kind">{node.kind || "fact"}</span>
                      <span className="mem-chip confidence">{confidencePercent(node.confidence)}%</span>
                    </span>
                  </button>
                );
              })
            )}
          </section>
        </main>

        <aside className={"mem-detail mode-" + mode} aria-label="Memory detail">
          {mode === "create" ? (
            <>
              <div className="mem-detail-head">
                <div>
                  <span className="mem-detail-kicker">Capture memory</span>
                  <h3>New memory</h3>
                </div>
              </div>

              <label className="field mem-field mem-capture-field">
                <span>Memory</span>
                <textarea
                  className="instr-input mem-body-input"
                  value={draft.body}
                  onChange={(e) => updateDraft({ body: e.target.value })}
                  placeholder="Write the fact, decision, preference, or project convention to remember..."
                />
              </label>

              <div className="mem-create-metadata-grid">
                <div className="mem-detail-section">
                  <span className="mem-section-label">Scope</span>
                  <div className="mem-scope-toggle" role="group" aria-label="New memory scope">
                    <button type="button" className={draft.scope === "thread" ? "active" : ""} onClick={() => updateDraft({ scope: "thread" })}>
                      Thread
                    </button>
                    <button
                      type="button"
                      className={draft.scope === "project" ? "active" : ""}
                      onClick={() => updateDraft({ scope: "project" })}
                      disabled={!canUseProject}
                      title={canUseProject ? "Store in current project" : "Select a working folder to use project memory"}
                    >
                      Project
                    </button>
                  </div>
                  <span className="mem-meta-line">{draft.scope === "project" && canUseProject ? projectLabel(folder) : threadTitle || "Current thread"}</span>
                </div>

                <button className="btn-ghost mem-more-btn" type="button" onClick={() => setShowAdvanced((value) => !value)} aria-expanded={showAdvanced}>
                  <MoreHorizontal size={14} />
                  More
                </button>
              </div>

              {showAdvanced && (
                <>
                  <label className="field mem-field">
                    <span>Title override</span>
                    <input className="css-input" value={draft.title} onChange={(e) => updateDraft({ title: e.target.value })} placeholder="Defaults to first line" />
                  </label>
                  <div className="mem-form-grid">
                    <label className="field mem-field">
                      <span>Kind</span>
                      <input className="css-input" value={draft.kind} onChange={(e) => updateDraft({ kind: e.target.value })} placeholder="fact" />
                    </label>
                    <label className="field mem-field">
                      <span>Source</span>
                      <input className="css-input" value={draft.source} onChange={(e) => updateDraft({ source: e.target.value })} placeholder="user" />
                    </label>
                  </div>
                  <div className="mem-detail-section">
                    <span className="mem-section-label">Confidence</span>
                    <div className="mem-confidence-row">
                      <Slider min={0} max={100} step={5} value={confidencePercent(draft.confidence)} onChange={(value) => updateDraft({ confidence: value / 100 })} />
                      <span>{confidencePercent(draft.confidence)}%</span>
                    </div>
                  </div>
                </>
              )}

              {note && <p className="sheet-hint mem-note">{note}</p>}
              <div className="agents-actions mem-detail-actions">
                <button className="btn-ghost" type="button" disabled={busy} onClick={() => setMode("view")}>Cancel</button>
                <span className="spacer" />
                <button className="btn-accent mem-action-btn" type="button" disabled={busy || !canSaveCreate} onClick={() => void addMemory()}>
                  <Check size={14} />
                  Store
                </button>
              </div>
            </>
          ) : selected ? (
            mode === "edit" ? (
              <>
                <div className="mem-detail-head">
                  <div>
                    <span className="mem-detail-kicker">Edit memory</span>
                    <h3>{nodeTitle(selected)}</h3>
                  </div>
                  {isArchived(selected) && <span className="mem-chip archived">archived</span>}
                </div>

                <label className="field mem-field">
                  <span>Title</span>
                  <input className="css-input" value={draft.title} onChange={(e) => updateDraft({ title: e.target.value })} />
                </label>
                <label className="field mem-field">
                  <span>Body</span>
                  <textarea className="instr-input mem-body-input" value={draft.body} onChange={(e) => updateDraft({ body: e.target.value })} />
                </label>

                <div className="mem-form-grid">
                  <label className="field mem-field">
                    <span>Kind</span>
                    <input className="css-input" value={draft.kind} onChange={(e) => updateDraft({ kind: e.target.value })} />
                  </label>
                  <label className="field mem-field">
                    <span>Source</span>
                    <input className="css-input" value={draft.source} onChange={(e) => updateDraft({ source: e.target.value })} />
                  </label>
                </div>

                <div className="mem-detail-section">
                  <span className="mem-section-label">Confidence</span>
                  <div className="mem-confidence-row">
                    <Slider min={0} max={100} step={5} value={confidencePercent(draft.confidence)} onChange={(value) => updateDraft({ confidence: value / 100 })} />
                    <span>{confidencePercent(draft.confidence)}%</span>
                  </div>
                </div>

                <div className="mem-meta-grid">
                  <span>Scope</span>
                  <strong>{scopeChipLabel(selected)}</strong>
                  <span>Created</span>
                  <strong>{formatDate(selected.created_at)}</strong>
                  <span>Updated</span>
                  <strong>{formatDate(selected.updated_at)}</strong>
                </div>

                {note && <p className="sheet-hint mem-note">{note}</p>}
                <div className="agents-actions mem-detail-actions">
                  <button className="btn-ghost" type="button" disabled={busy} onClick={() => setMode("view")}>Cancel</button>
                  <span className="spacer" />
                  <button className="btn-accent mem-action-btn" type="button" disabled={busy || !canSaveEdit} onClick={() => void saveSelected()}>
                    <Check size={14} />
                    Save
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mem-detail-head">
                  <div>
                    <span className="mem-detail-kicker">Memory detail</span>
                    <h3>{nodeTitle(selected)}</h3>
                  </div>
                  <span className={"mem-chip scope " + selected.scope_kind}>{scopeKindLabel(selected.scope_kind)}</span>
                </div>

                <div className="mem-detail-body">{selected.body.trim() ? selected.body : <span className="mem-muted">No body stored.</span>}</div>

                <div className="mem-reason-card">
                  <span className="mem-section-label">Next prompt</span>
                  {searchActive ? (
                    <>
                      <strong>{nextRunIds.has(selected.id) ? "Included in next prompt" : "Not in the top prompt context"}</strong>
                      <span>
                        {scores[selected.id] != null
                          ? nextRunIds.has(selected.id)
                            ? "This memory is one of the top active search results."
                            : "This memory matched the search but is outside the top prompt context."
                          : "This memory is visible through filters, not the current search."}
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>Browse mode</strong>
                      <span>Search or use Current prompt to preview whether this memory would be included.</span>
                    </>
                  )}
                </div>

                <div className="mem-meta-grid">
                  <span>Kind</span>
                  <strong>{selected.kind || "fact"}</strong>
                  <span>Source</span>
                  <strong>{selected.source || "user"}</strong>
                  <span>Confidence</span>
                  <strong>{confidencePercent(selected.confidence)}%</strong>
                  <span>Scope</span>
                  <strong>{scopeChipLabel(selected)}</strong>
                  <span>Created</span>
                  <strong>{formatDate(selected.created_at)}</strong>
                  <span>Updated</span>
                  <strong>{formatDate(selected.updated_at)}</strong>
                  {selected.archived_at && (
                    <>
                      <span>Archived</span>
                      <strong>{formatDate(selected.archived_at)}</strong>
                    </>
                  )}
                </div>

                <div className="mem-prompt-card">
                  <span className="mem-section-label">Next prompt context</span>
                  {searchActive ? (
                    promptPreview ? <pre>{promptPreview}</pre> : <p>No active memories would be sent for this search.</p>
                  ) : (
                    <p>Search, or use Current prompt, to preview the memory block before the next run.</p>
                  )}
                </div>

                {note && <p className="sheet-hint mem-note">{note}</p>}
                <div className="agents-actions mem-detail-actions">
                  {!isArchived(selected) ? (
                    <button className="btn-ghost mem-action-btn" type="button" disabled={busy} onClick={() => void archiveSelected()}>
                      <Archive size={14} />
                      Archive
                    </button>
                  ) : (
                    <button className="btn-ghost danger mem-action-btn" type="button" disabled={busy} onClick={() => void deleteSelected()}>
                      {confirmDeleteId === selected.id ? <Check size={14} /> : <Trash size={14} />}
                      {confirmDeleteId === selected.id ? "Confirm delete" : "Delete"}
                    </button>
                  )}
                  <span className="spacer" />
                  <button className="btn-ghost mem-action-btn" type="button" disabled={busy} onClick={startEdit}>
                    <Pencil size={14} />
                    Edit
                  </button>
                </div>
              </>
            )
          ) : (
            <div className="mem-detail-empty">
              <strong>{busy ? "Loading memories..." : filteredNodes.length === 0 ? listEmpty.title : searchActive ? "No memory selected" : "Select a memory"}</strong>
              <span>
                {busy
                  ? "Fetching the current scope."
                  : filteredNodes.length === 0
                    ? listEmpty.body
                    : searchActive
                      ? "Choose a search result or clear search to browse this scope."
                      : "Open a row to inspect metadata, archive stale context, or edit content."}
              </span>
              {filteredNodes.length === 0 && searchActive ? (
                <button className="btn-ghost mem-action-btn" type="button" disabled={busy} onClick={() => void clearSearch()}>
                  <X size={13} />
                  Clear
                </button>
              ) : (
                <button className="btn-accent mem-action-btn" type="button" disabled={busy} onClick={startCreate}>
                  <Plus size={14} />
                  Capture
                </button>
              )}
            </div>
          )}
        </aside>
      </div>
    </SheetDialog>
  );
}
