import { useEffect, useMemo, useState } from "react";
import {
  deleteRunJournalEntry,
  listRunJournalEntries,
  type RunJournalEntry,
} from "../api";
import { Archive, Search, Trash, X } from "./icons";
import { SheetDialog } from "./SheetDialog";
import { Select } from "./ui";
import "./AgentsManager.css";
import "./RunJournalManager.css";

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

function statusTone(status: string): "ready" | "warning" | "error" {
  if (status === "done") return "ready";
  if (status === "error" || status === "aborted" || status === "interrupted") return "error";
  return "warning";
}

function runSubtitle(run: RunJournalEntry): string {
  return [run.kind, run.model, run.provider, run.workspace].filter(Boolean).join(" / ");
}

export function runJournalAttachBlock(run: RunJournalEntry): string {
  const lines = [
    "Context from prior Milim run:",
    `Run: ${run.title || run.id}`,
    `Status: ${run.status}`,
    `Model: ${[run.provider, run.model].filter(Boolean).join(" / ") || run.model}`,
    run.workspace ? `Workspace: ${run.workspace}` : "",
    "",
    "Goal:",
    run.goal || run.input_excerpt,
    "",
    "Outcome:",
    run.output_excerpt || run.error || "(no output recorded)",
    run.files?.length ? ["", "Files:", ...run.files.map((file) => `- ${file}`)].join("\n") : "",
    run.artifacts?.length ? ["", "Artifacts:", ...run.artifacts.map((artifact) => `- ${artifact}`)].join("\n") : "",
    "",
    `Source run id: ${run.id}`,
  ].filter(Boolean);
  return lines.join("\n");
}

export function RunJournalManager({
  onClose,
  onAttach,
  onOpenSession,
}: {
  onClose: () => void;
  onAttach: (text: string) => void;
  onOpenSession: (sessionId: string) => void;
}) {
  const [runs, setRuns] = useState<RunJournalEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    const next = await listRunJournalEntries({ q, status, kind, limit: 100 });
    setRuns(next);
    setSelectedId((current) => current && next.some((run) => run.id === current) ? current : next[0]?.id ?? null);
    setBusy(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => runs.find((run) => run.id === selectedId) ?? null,
    [runs, selectedId],
  );
  const kinds = useMemo(() => [...new Set(runs.map((run) => run.kind).filter(Boolean))], [runs]);

  async function removeSelected() {
    if (!selected) return;
    await deleteRunJournalEntry(selected.id);
    setNote("Run deleted.");
    await load();
  }

  return (
    <SheetDialog title="Run Journal" className="sheet agents-sheet agent-manager-sheet run-journal-sheet" onClose={onClose}>
      <div className="agent-manager-header">
        <div className="agent-manager-title">
          <h2>Run Journal</h2>
          <p>Search prior goal attempts and attach one as visible context.</p>
        </div>
        <div className="agent-manager-header-actions">
          <button className="icon-btn sheet-close agent-close" type="button" onClick={onClose} title="Close" aria-label="Close Run Journal">
            <X size={15} />
          </button>
        </div>
      </div>

      <div className="agent-manager-body run-journal-body">
        <aside className="agent-rail" aria-label="Runs">
          <div className="agent-rail-summary">
            <span>{runs.length} runs</span>
            <span>{busy ? "Loading" : "Ready"}</span>
          </div>
          <label className="mp-search run-journal-search">
            <Search size={14} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search runs" aria-label="Search runs" />
          </label>
          <div className="run-journal-filter-row">
            <Select
              value={status}
              onChange={setStatus}
              options={[
                { value: "", label: "Any status" },
                { value: "done", label: "Done" },
                { value: "error", label: "Error" },
                { value: "aborted", label: "Aborted" },
                { value: "interrupted", label: "Interrupted" },
              ]}
            />
            <Select
              value={kind}
              onChange={setKind}
              options={[{ value: "", label: "Any kind" }, ...kinds.map((value) => ({ value, label: value }))]}
            />
          </div>
          <button className="agent-rail-action" type="button" disabled={busy} onClick={() => void load()}>
            Search
          </button>

          {note && <p className="sheet-hint run-journal-note">{note}</p>}
          <div className="agent-list">
            {runs.length === 0 ? (
              <div className="agent-list-placeholder">No runs found</div>
            ) : runs.map((run) => (
              <button
                key={run.id}
                type="button"
                className={"agent-list-card run-journal-row" + (run.id === selectedId ? " active" : "")}
                onClick={() => setSelectedId(run.id)}
              >
                <span className={"run-journal-dot " + statusTone(run.status)} />
                <span className="agent-card-copy">
                  <span className="agent-card-name">{run.title || run.goal || run.id}</span>
                  <span className="agent-card-meta">{runSubtitle(run) || fmtTime(run.created_at_ms)}</span>
                </span>
              </button>
            ))}
          </div>
        </aside>

        <main className="agent-editor-panel run-journal-detail">
          {selected ? (
            <div className="agent-editor">
              <div className="agent-editor-head run-journal-detail-head">
                <div>
                  <span className="agent-editor-kicker">{fmtTime(selected.created_at_ms)}</span>
                  <h3>{selected.title || selected.goal}</h3>
                  <p>{runSubtitle(selected)}</p>
                </div>
                <span className={"run-journal-status " + statusTone(selected.status)}>{selected.status}</span>
              </div>
              <section className="agent-editor-section">
                <h4>Goal</h4>
                <p>{selected.input_excerpt || selected.goal}</p>
              </section>
              <section className="agent-editor-section">
                <h4>Outcome</h4>
                <p>{selected.output_excerpt || selected.error || "No output recorded."}</p>
              </section>
              <div className="agent-impact-panel run-journal-meta">
                <span className="agent-impact-item">Duration <strong>{selected.duration_ms ? `${Math.round(selected.duration_ms / 1000)}s` : "n/a"}</strong></span>
                <span className="agent-impact-item">Tokens <strong>{selected.total_tokens ?? "n/a"}</strong></span>
                <span className="agent-impact-item">Files <strong>{selected.files?.length ?? 0}</strong></span>
                <span className="agent-impact-item">Tools <strong>{selected.tools?.length ?? 0}</strong></span>
              </div>
              {(selected.files?.length || selected.tools?.length || selected.artifacts?.length) ? (
                <section className="agent-editor-section">
                  <h4>Run Surface</h4>
                  <ul>
                    {[...(selected.files ?? []), ...(selected.tools ?? []), ...(selected.artifacts ?? [])].slice(0, 24).map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </section>
              ) : null}
              <div className="run-journal-actions">
                {selected.session_id && (
                  <button className="btn-ghost" type="button" onClick={() => onOpenSession(selected.session_id!)}>
                    <Archive size={14} />
                    Open chat
                  </button>
                )}
                <button className="btn-ghost danger" type="button" onClick={() => void removeSelected()}>
                  <Trash size={14} />
                  Delete
                </button>
                <span className="spacer" />
                <button className="btn-accent" type="button" onClick={() => onAttach(runJournalAttachBlock(selected))}>
                  Attach to composer
                </button>
              </div>
            </div>
          ) : (
            <div className="agent-empty-state">Select a run</div>
          )}
        </main>
      </div>
    </SheetDialog>
  );
}
