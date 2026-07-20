import { useState } from "react";
import type {
  WorkspaceCheckpoint,
  WorkspaceGitActionResult,
} from "../api";
import {
  diffRows,
  diffSections,
  diffStats,
  type DiffSection,
  type DiffStats,
} from "../lib/gitDiffRows";
import { ChevronDown, Eye, FileText, Refresh } from "./icons";

const COLLAPSED_FILE_COUNT = 3;

export type TurnChanges = {
  key: string;
  checkpoint: WorkspaceCheckpoint;
  result: WorkspaceGitActionResult;
  sections: DiffSection[];
  stats: DiffStats;
};

export function turnChangesFromDiff(
  key: string,
  checkpoint: WorkspaceCheckpoint,
  result: WorkspaceGitActionResult,
): TurnChanges | null {
  if (!result.ok) return null;
  const output = [result.stdout, result.stderr]
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  if (!output) return null;
  const rows = diffRows(output);
  const sections = diffSections(rows);
  if (!sections.length) return null;
  return { key, checkpoint, result, sections, stats: diffStats(rows) };
}

export function TurnChangesCard({
  sections,
  stats,
  onUndo,
  onReview,
}: {
  sections: DiffSection[];
  stats: DiffStats;
  onUndo: () => void;
  onReview: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hiddenCount = Math.max(0, sections.length - COLLAPSED_FILE_COUNT);
  const visibleSections = expanded
    ? sections
    : sections.slice(0, COLLAPSED_FILE_COUNT);

  return (
    <section
      className="turn-changes-card"
      data-testid="turn-changes-card"
      aria-label="Turn changes"
    >
      <div className="turn-changes-head">
        <span className="turn-changes-icon" aria-hidden="true">
          <FileText size={15} />
        </span>
        <div className="turn-changes-title">
          <strong>
            Changed {stats.files} file{stats.files === 1 ? "" : "s"}
          </strong>
          <span className="turn-changes-total">
            <span className="add">+{stats.additions}</span>
            <span className="delete">-{stats.deletions}</span>
          </span>
        </div>
        <div className="turn-changes-actions">
          <button data-testid="turn-changes-undo" type="button" onClick={onUndo}>
            <Refresh size={12} />
            <span>Undo</span>
          </button>
          <button data-testid="turn-changes-review" type="button" onClick={onReview}>
            <Eye size={12} />
            <span>Review changes</span>
          </button>
        </div>
      </div>
      <div className="turn-changes-files">
        {visibleSections.map((section) => (
          <div className="turn-changes-file" key={section.id}>
            <code title={section.path}>{section.path}</code>
            <span className="turn-changes-file-stat">
              <span className="add">+{section.additions}</span>
              <span className="delete">-{section.deletions}</span>
            </span>
          </div>
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          className="turn-changes-toggle"
          data-testid="turn-changes-toggle"
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <span>{expanded ? "Show less" : `Show ${hiddenCount} more`}</span>
          <ChevronDown size={12} />
        </button>
      )}
    </section>
  );
}
