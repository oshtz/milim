import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getCodexRateLimits, isCodexModel } from "../api";
import type {
  QuickSummary,
  QuickSummaryRow,
  QuickSummaryRowKind,
  QuickSummarySource,
} from "../lib/quickSummary";
import { codexLimitsFromRateLimitPayload, formatProviderLimits } from "../lib/usageMetrics";
import { FileText, Folder, Globe, Paperclip, Sparkles, Terminal, UserRound, X } from "./icons";

const SOURCE_LIMIT = 5;

function toneClass(tone?: QuickSummaryRow["tone"]): string {
  return tone ? ` ${tone}` : "";
}

function rowIcon(row: QuickSummaryRow): ReactNode {
  switch (row.kind) {
    case "workspace":
      return <Folder size={13} />;
    case "browser":
      return <Globe size={13} />;
    case "model":
      return <Sparkles size={13} />;
    case "workers":
      return <UserRound size={13} />;
    case "activity":
      return <Terminal size={13} />;
    default:
      return <FileText size={13} />;
  }
}

function sourceIcon(source: QuickSummarySource): ReactNode {
  if (source.kind === "attachment") return <Paperclip size={13} />;
  if (source.kind === "memory") return <Sparkles size={13} />;
  return <FileText size={13} />;
}

function ContextRow({ row, onClick }: { row: QuickSummaryRow; onClick?: () => void }) {
  const content = (
    <>
      <span className="quick-summary-row-icon" aria-hidden="true">{rowIcon(row)}</span>
      <span className="quick-summary-row-copy">
        <strong>{row.label}</strong>
        <small>{row.value}</small>
        {row.meta && <em>{row.meta}</em>}
      </span>
    </>
  );
  if (!onClick) {
    return <div className={`quick-summary-row${toneClass(row.tone)}`} title={row.title}>{content}</div>;
  }
  return (
    <button className={`quick-summary-row${toneClass(row.tone)}`} type="button" title={row.title} onClick={onClick}>
      {content}
    </button>
  );
}

function SourceRow({ source }: { source: QuickSummarySource }) {
  return (
    <div className="quick-summary-row quick-summary-source-row" title={source.label}>
      <span className="quick-summary-row-icon" aria-hidden="true">{sourceIcon(source)}</span>
      <span className="quick-summary-row-copy">
        <strong>{source.label}</strong>
        <small>{source.kind}</small>
      </span>
    </div>
  );
}

export function QuickSummaryPanel({
  summary,
  open,
  canOpenGit,
  onOpenChange,
  onOpenGit,
  onOpenGoal,
  onOpenWorkers,
}: {
  summary: QuickSummary;
  open: boolean;
  canOpenGit: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenGit: () => void;
  onOpenGoal: () => void;
  onOpenWorkers: () => void;
}) {
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];
  const sources = Array.isArray(summary?.sources) ? summary.sources : [];
  const [liveQuota, setLiveQuota] = useState("");
  const model = summary?.model?.trim() ?? "";

  useEffect(() => {
    if (!open || !isCodexModel(model)) {
      setLiveQuota("");
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const value = formatProviderLimits(codexLimitsFromRateLimitPayload(await getCodexRateLimits()));
        if (!cancelled) setLiveQuota(value ?? "");
      } catch {
        if (!cancelled) setLiveQuota("");
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [model, open]);

  const displayRows = useMemo(() => {
    if (!liveQuota) return rows;
    const quota: QuickSummaryRow = { kind: "limits", label: "Provider quota", value: liveQuota };
    const index = rows.findIndex((row) => row.kind === "limits");
    if (index >= 0) return rows.map((row, rowIndex) => rowIndex === index ? quota : row);
    const modelIndex = rows.findIndex((row) => row.kind === "model");
    return [...rows.slice(0, modelIndex + 1), quota, ...rows.slice(modelIndex + 1)];
  }, [liveQuota, rows]);

  const groups: Array<{ label: string; kinds: QuickSummaryRowKind[] }> = [
    { label: "Environment", kinds: ["workspace", "browser"] },
    { label: "Task", kinds: ["goal", "plan"] },
    { label: "Activity", kinds: ["workers", "activity"] },
    { label: "Context", kinds: ["model", "usage", "limits", "privacy", "memory"] },
  ];

  return (
    <aside
      id="quick-summary-panel"
      className={`quick-summary-panel${open ? " open" : ""}`}
      data-testid="quick-summary-panel"
      aria-labelledby={open ? "quick-summary-title" : undefined}
      aria-hidden={!open}
    >
      {open && (
        <div className="quick-summary-card">
          <div className="quick-summary-toolbar">
            <strong id="quick-summary-title">Context</strong>
            <button className="icon-btn quick-summary-close" type="button" title="Close context" aria-label="Close context" onClick={() => onOpenChange(false)}>
              <X size={14} />
            </button>
          </div>
          <div className="quick-summary-scroll">
            {groups.map((group) => {
              const sectionRows = displayRows.filter((row) => group.kinds.includes(row.kind));
              if (!sectionRows.length) return null;
              return (
                <section className="quick-summary-section" key={group.label} aria-labelledby={`quick-summary-${group.label.toLowerCase()}`}>
                  <h3 id={`quick-summary-${group.label.toLowerCase()}`}>{group.label}</h3>
                  {sectionRows.map((row) => (
                    <ContextRow
                      key={row.kind}
                      row={row}
                      onClick={
                        row.kind === "workspace" && canOpenGit
                          ? onOpenGit
                          : row.kind === "goal"
                            ? onOpenGoal
                            : row.kind === "workers"
                              ? onOpenWorkers
                              : undefined
                      }
                    />
                  ))}
                </section>
              );
            })}
            <section className="quick-summary-section" aria-labelledby="quick-summary-sources">
              <h3 id="quick-summary-sources">Sources</h3>
              {sources.length ? (
                <>
                  {sources.slice(0, SOURCE_LIMIT).map((source) => (
                    <SourceRow key={`${source.kind}:${source.label}`} source={source} />
                  ))}
                  {sources.length > SOURCE_LIMIT && (
                    <div className="quick-summary-more">{sources.length - SOURCE_LIMIT} more</div>
                  )}
                </>
              ) : (
                <div className="quick-summary-empty">None</div>
              )}
            </section>
          </div>
        </div>
      )}
    </aside>
  );
}
