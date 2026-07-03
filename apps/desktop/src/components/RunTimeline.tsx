import { useEffect, useState } from "react";
import type { RunStatus, RunTrace } from "../api";

const STATUS_LABEL: Record<RunStatus, string> = {
  running: "Running",
  done: "Done",
  stopped: "Stopped",
  aborted: "Stopped",
  error: "Error",
};
const MUTATING_TOOLS = new Set(["write_file", "edit_file", "patch_file"]);

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function compactText(value: string, max = 120): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function parseArgs(args?: string): Record<string, unknown> | null {
  if (!args?.trim()) return null;
  try {
    return asRecord(JSON.parse(args));
  } catch {
    return null;
  }
}

function stringArg(args: Record<string, unknown> | null, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberField(record: Record<string, unknown> | null, keys: string[]): number {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function fileChangeSummary(run: RunTrace): string | null {
  const files = new Set<string>();
  let added = 0;
  let removed = 0;
  for (const step of run.steps) {
    if (!MUTATING_TOOLS.has(step.name) || step.error || step.endedAt == null) continue;
    const args = parseArgs(step.arguments);
    const path = stringArg(args, "path");
    if (path) files.add(path);
    const result = asRecord(step.result);
    added += numberField(result, ["added", "additions", "insertions", "lines_added"]);
    removed += numberField(result, ["removed", "removals", "deletions", "lines_removed"]);
  }
  if (files.size === 0) return null;
  const stats = added || removed ? ` +${added} -${removed}` : "";
  return `${files.size} file${files.size === 1 ? "" : "s"} changed${stats}`;
}

function stepDetail(step: RunTrace["steps"][number]): string | null {
  const args = parseArgs(step.arguments);
  const path = stringArg(args, "path");
  const command = stringArg(args, "command");
  const url = stringArg(args, "url");
  if (step.error) return compactText(path ? `${path}: ${step.error}` : step.error);
  if (command) return compactText(command);
  if (path) return compactText(path);
  if (url) return compactText(url);
  if (step.result !== undefined) return compactText(typeof step.result === "string" ? step.result : safeJson(step.result), 160);
  return null;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Structured timeline of an agent/tool-use run: status, model, elapsed time,
 *  and each tool call with its arguments, result, and per-step duration. */
export function RunTimeline({ run }: { run: RunTrace }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (run.status !== "running") return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [run.status]);

  const elapsed = Math.max(0, (run.endedAt ?? now) - run.startedAt);
  const doneSteps = run.steps.filter((step) => step.endedAt != null).length;
  const activeStep = run.status === "running" ? Math.max(1, doneSteps + 1) : doneSteps;
  const stepLabel = run.steps.length ? `Step ${Math.min(activeStep, run.steps.length)} / ${run.steps.length}` : STATUS_LABEL[run.status];
  const files = fileChangeSummary(run);
  const steps = run.steps.map((step) => ({ step, detail: stepDetail(step) }));

  if (run.status === "done") return null;

  return (
    <div className={`run-timeline run-${run.status}`}>
      <button className="run-pill" type="button" aria-label="Show run steps">
        <span className={`run-dot run-dot-${run.status}`} />
        <span className={"run-status" + (run.status === "running" ? " shiny-text" : "")}>{stepLabel}</span>
        {files && <span className="run-files">{files}</span>}
        <span className="run-meta run-elapsed">{fmtDuration(elapsed)}</span>
      </button>
      <div className="run-body" role="tooltip">
        <div className="run-popover-head">
          <span className={"run-status" + (run.status === "running" ? " shiny-text" : "")}>{STATUS_LABEL[run.status]}</span>
          {run.model && <span className="run-model">{run.model}</span>}
          <span className="run-meta run-elapsed">{fmtDuration(elapsed)}</span>
        </div>
        {steps.map(({ step: s, detail }, i) => (
          <div className="run-step" key={i}>
            <span className={`run-step-dot ${s.error ? "error" : s.endedAt == null ? "running" : "done"}`} />
            <div className="run-step-head">
              <span className="run-step-name">{s.name}</span>
              <span className="run-meta">
                {s.endedAt != null ? fmtDuration(s.endedAt - s.startedAt) : "..."}
              </span>
            </div>
            {detail && <div className="run-step-detail">{detail}</div>}
          </div>
        ))}
        {run.error && <div className="run-step-detail run-step-error">{run.error}</div>}
        {run.status === "stopped" && <div className="run-note">Stopped before final answer.</div>}
      </div>
    </div>
  );
}
