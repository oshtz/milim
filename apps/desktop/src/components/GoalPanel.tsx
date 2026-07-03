import { useEffect, useMemo, useState } from "react";
import { goalConfigured, type GoalSettings } from "../lib/goals";
import { ArrowRight, Square, Trash, X } from "./icons";
import { SheetDialog } from "./SheetDialog";

export type GoalPanelDraft = Pick<GoalSettings, "objective" | "successCriteria" | "constraints" | "developerMaxTurns">;

function statusLabel(status: GoalSettings["status"]): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "running":
      return "Running";
    case "paused":
      return "Paused";
    case "complete":
      return "Complete";
    case "blocked":
      return "Blocked";
    case "error":
      return "Error";
  }
}

function parseCap(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
}

export function GoalPanel({
  goal,
  prefillObjective,
  onSave,
  onRun,
  onPause,
  onDelete,
  onClose,
}: {
  goal: GoalSettings;
  prefillObjective: string | null;
  onSave: (draft: GoalPanelDraft) => void;
  onRun: (draft: GoalPanelDraft) => void;
  onPause: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [objective, setObjective] = useState("");
  const [successCriteria, setSuccessCriteria] = useState("");
  const [constraints, setConstraints] = useState("");
  const [developerMaxTurns, setDeveloperMaxTurns] = useState("");
  const configured = goalConfigured(goal);
  const running = goal.status === "running";

  useEffect(() => {
    setObjective(prefillObjective?.trim() || goal.objective);
    setSuccessCriteria(goal.successCriteria);
    setConstraints(goal.constraints);
    setDeveloperMaxTurns(goal.developerMaxTurns ? String(goal.developerMaxTurns) : "");
  }, [goal, prefillObjective]);

  const draft = useMemo<GoalPanelDraft>(() => ({
    objective,
    successCriteria,
    constraints,
    developerMaxTurns: parseCap(developerMaxTurns),
  }), [constraints, developerMaxTurns, objective, successCriteria]);
  const canRun = objective.trim().length > 0;

  return (
    <SheetDialog title="Goal" className="sheet goal-sheet" testId="goal-panel" onClose={onClose}>
      <div className="sheet-header goal-header">
        <div>
          <h2>Goal</h2>
          <p className="sheet-sub">Autonomous continuation for this thread.</p>
        </div>
        <button className="icon-btn sheet-close" type="button" onClick={onClose} title="Close" aria-label="Close goal">
          <X size={16} />
        </button>
      </div>

      <div className="goal-status-row">
        <span className={"goal-status-dot " + goal.status} aria-hidden="true" />
        <span className="goal-status-title">{statusLabel(goal.status)}</span>
        <span className="goal-status-reason">{goal.lastReason || "No recent decision."}</span>
      </div>

      <div className="goal-form">
        <label className="goal-field">
          <span>Objective</span>
          <textarea
            className="instr-input goal-objective"
            value={objective}
            onChange={(event) => setObjective(event.currentTarget.value)}
            placeholder="What should the agent accomplish?"
          />
        </label>
        <label className="goal-field">
          <span>Success criteria</span>
          <textarea
            className="instr-input"
            value={successCriteria}
            onChange={(event) => setSuccessCriteria(event.currentTarget.value)}
            placeholder="How should the agent know the goal is complete?"
          />
        </label>
        <label className="goal-field">
          <span>Constraints</span>
          <textarea
            className="instr-input"
            value={constraints}
            onChange={(event) => setConstraints(event.currentTarget.value)}
            placeholder="Boundaries, preferences, or things to avoid."
          />
        </label>
        <label className="goal-field goal-cap-field">
          <span>Advanced developer max-turn cap</span>
          <input
            className="name-input"
            type="number"
            min={1}
            value={developerMaxTurns}
            onChange={(event) => setDeveloperMaxTurns(event.currentTarget.value)}
            placeholder="Empty means uncapped"
          />
        </label>
      </div>

      <div className="goal-actions">
        {running ? (
          <button className="btn-accent" type="button" onClick={onPause}>
            <Square size={13} />
            Pause
          </button>
        ) : (
          <button className="btn-accent" type="button" disabled={!canRun} onClick={() => onRun(draft)}>
            <ArrowRight size={14} />
            {goal.status === "paused" ? "Resume" : "Run"}
          </button>
        )}
        <button className="btn-ghost" type="button" disabled={!canRun} onClick={() => onSave(draft)}>
          Save edits
        </button>
        {configured && (
          <button className="btn-ghost danger" type="button" onClick={onDelete}>
            <Trash size={14} />
            Delete
          </button>
        )}
      </div>
    </SheetDialog>
  );
}
