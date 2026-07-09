import type { ReactNode } from "react";
import type { QuickSummary, QuickSummaryRow } from "../lib/quickSummary";
import { FileText, Folder, Globe, Paperclip, Sparkles, X } from "./icons";

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
    case "sources":
      return <Paperclip size={13} />;
    default:
      return <FileText size={13} />;
  }
}

function ContextRow({
  row,
  onClick,
}: {
  row: QuickSummaryRow;
  onClick?: () => void;
}) {
  const content = (
    <>
      <span className="quick-summary-row-icon" aria-hidden="true">
        {rowIcon(row)}
      </span>
      <span className="quick-summary-row-copy">
        <strong>{row.label}</strong>
        <small>{row.value}</small>
        {row.meta && <em>{row.meta}</em>}
      </span>
    </>
  );
  if (!onClick) {
    return (
      <div className={`quick-summary-row${toneClass(row.tone)}`} title={row.title}>
        {content}
      </div>
    );
  }
  return (
    <button
      className={`quick-summary-row${toneClass(row.tone)}`}
      type="button"
      title={row.title}
      onClick={onClick}
    >
      {content}
    </button>
  );
}

export function QuickSummaryPanel({
  summary,
  open,
  canOpenGit,
  reserveSidePanelButtonSpace,
  onOpenChange,
  onOpenGit,
  onOpenGoal,
  onFocusComposer,
}: {
  summary: QuickSummary;
  open: boolean;
  canOpenGit: boolean;
  reserveSidePanelButtonSpace: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenGit: () => void;
  onOpenGoal: () => void;
  onFocusComposer: () => void;
}) {
  const rows = Array.isArray(summary?.rows) ? summary.rows : [];
  return (
    <div
      className={`quick-summary-pull${open ? " expanded" : ""}${reserveSidePanelButtonSpace ? " with-side-panel-button" : ""}`}
      data-testid="quick-summary-panel"
    >
      {!open && (
        <button
          className="icon-btn quick-summary-pull-tab"
          type="button"
          title="Open context"
          aria-label="Open context"
          aria-expanded={open}
          aria-controls="quick-summary-drawer"
          onClick={() => onOpenChange(true)}
        >
          <FileText size={15} />
        </button>
      )}
      <aside
        id="quick-summary-drawer"
        className="quick-summary-drawer"
        aria-label="Thread context"
        aria-hidden={!open}
      >
        <div className="quick-summary-toolbar">
          <strong>Context</strong>
          <button
            className="icon-btn quick-summary-close"
            type="button"
            title="Close context"
            aria-label="Close context"
            onClick={() => onOpenChange(false)}
          >
            <X size={14} />
          </button>
        </div>
        <div className="quick-summary-scroll">
          {rows.map((row) => (
            <ContextRow
              key={row.kind}
              row={row}
              onClick={
                row.kind === "workspace" && canOpenGit
                  ? onOpenGit
                  : row.kind === "goal"
                    ? onOpenGoal
                    : row.kind === "sources"
                      ? onFocusComposer
                      : undefined
              }
            />
          ))}
        </div>
      </aside>
    </div>
  );
}
