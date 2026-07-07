import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  type ModelInfo,
  type PrivacyMode,
  type RunTrace,
  type ToolApprovalMode,
} from "../api";
import { goalChipVisible, type GoalSettings } from "../lib/goals";
import { modelDisplayName } from "../lib/modelPicker";
import { featureVisibleInMode } from "../ui/features";
import { useUiPreferences } from "../ui/store";
import { ChevronDown, Cube, Folder, Lightbulb, Pin } from "./icons";
import { ModelPicker } from "./ModelPicker";
import { RunTimeline } from "./RunTimeline";

function Shield({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3l7 3v5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V6l7-3z" />
    </svg>
  );
}

const PRIVACY_LABEL: Record<PrivacyMode, string> = {
  off: "Off",
  redact: "Redact",
  block: "Block",
};

const TOOL_APPROVAL_LABEL: Record<ToolApprovalMode, string> = {
  review: "Review gate",
  guarded: "Guarded run",
  open: "Open / bypass permissions",
};

function Monitor({ size = 13 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

export function ControlBar({
  models,
  model,
  onModel,
  sandbox,
  onToggleSandbox,
  computerUse,
  onToggleComputer,
  memory,
  onToggleMemory,
  planMode,
  onTogglePlanMode,
  privacy,
  onCyclePrivacy,
  toolApproval,
  onCycleToolApproval,
  onManageProviders,
  onManageMcp,
  onManageMemory,
  goal,
  onOpenGoal,
  activeRun,
  inlineControls,
}: {
  models: ModelInfo[];
  model: string;
  onModel: (m: string) => void;
  sandbox: boolean;
  onToggleSandbox: () => void;
  computerUse: boolean;
  onToggleComputer: () => void;
  memory: boolean;
  onToggleMemory: () => void;
  planMode: boolean;
  onTogglePlanMode: () => void;
  privacy: PrivacyMode;
  onCyclePrivacy: () => void;
  toolApproval: ToolApprovalMode;
  onCycleToolApproval: () => void;
  onManageProviders: () => void;
  onManageMcp: () => void;
  onManageMemory: () => void;
  goal: GoalSettings;
  onOpenGoal: () => void;
  activeRun?: RunTrace | null;
  inlineControls?: ReactNode;
}) {
  const [menu, setMenu] = useState<null | "model" | "context">(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onDoc = (e: MouseEvent) => {
      const target = e.target;
      if (target instanceof Element && target.closest(".mp-effort-menu"))
        return;
      if (
        ref.current &&
        target instanceof Node &&
        !ref.current.contains(target)
      )
        setMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menu]);

  const interfaceMode = useUiPreferences((s) => s.interfaceMode);
  const showSandbox = featureVisibleInMode("sandbox", interfaceMode) || sandbox;
  const showComputerUse =
    featureVisibleInMode("computerUse", interfaceMode) || computerUse;
  const showMemoryManager = featureVisibleInMode(
    "memoryManager",
    interfaceMode,
  );
  const activeContextCount = [
    showSandbox && sandbox,
    showComputerUse && computerUse,
    planMode,
    memory,
    privacy !== "off",
    toolApproval !== "guarded",
  ].filter(Boolean).length;
  const contextSummary =
    activeContextCount === 0 ? "None active" : `${activeContextCount} active`;
  const showGoalChip = goalChipVisible(goal);
  const goalDetail = goal.status[0].toUpperCase() + goal.status.slice(1);
  const activeModel = models.find((item) => item.id === model);
  const activeModelLabel = activeModel ? modelDisplayName(activeModel) : model;

  return (
    <div className="control-bar">
      <div className="chips" ref={ref}>
        {/* Model */}
        <div className="chip-wrap">
          <button
            type="button"
            className="chip"
            data-testid="model-picker-trigger"
            onClick={() => setMenu((m) => (m === "model" ? null : "model"))}
            title="Choose model"
            aria-label={`Choose model${activeModelLabel ? `, current model ${activeModelLabel}` : ""}`}
            aria-haspopup="dialog"
            aria-expanded={menu === "model"}
          >
            <span className="dot dot-green" />
            <span className="chip-label">{activeModelLabel || "Choose model"}</span>
            <ChevronDown size={12} className="chip-chev" />
          </button>
          {menu === "model" && (
            <ModelPicker
              models={models}
              model={model}
              onModel={onModel}
              onManageProviders={onManageProviders}
              onManageMcp={onManageMcp}
              onManageMemory={onManageMemory}
              onClose={() => setMenu(null)}
            />
          )}
        </div>

        {inlineControls && (
          <div className="control-inline-slot">{inlineControls}</div>
        )}

        {showGoalChip && (
          <button
            type="button"
            className="chip chip-on"
            data-testid="goal-panel-trigger"
            onClick={onOpenGoal}
            title="Goal"
            aria-label={`Goal, ${goalDetail}`}
          >
            <Pin size={13} />
            <span className="chip-label">Goal</span>
            <span className="chip-detail">{goalDetail}</span>
          </button>
        )}

        {planMode && (
          <button
            type="button"
            className="chip chip-on"
            data-testid="plan-mode-chip"
            onClick={onTogglePlanMode}
            title="Plan Mode is active. Click to turn it off."
            aria-label="Plan Mode active, read-only"
          >
            <Lightbulb size={13} />
            <span className="chip-label">Plan</span>
            <span className="chip-detail">Read-only</span>
          </button>
        )}

        <div className="context-cluster">
          {activeRun && (
            <div className="control-run-wrap">
              <RunTimeline run={activeRun} />
            </div>
          )}

          {/* Session controls */}
          <div className="chip-wrap context-chip-wrap">
            <button
              type="button"
              className={
                "chip context-chip" + (activeContextCount ? " chip-on" : "")
              }
              data-testid="context-menu-trigger"
              onClick={() =>
                setMenu((m) => (m === "context" ? null : "context"))
              }
              title="Session controls"
              aria-label={`Session controls, ${contextSummary}`}
              aria-haspopup="menu"
              aria-expanded={menu === "context"}
            >
              <Folder size={13} />
              <span className="chip-label">Session</span>
              <span className="chip-detail">
                {activeContextCount ? contextSummary : ""}
              </span>
              <ChevronDown size={12} className="chip-chev" />
            </button>
            {menu === "context" && (
              <div
                className="context-menu"
                role="menu"
                aria-label="Session controls"
              >
                {showSandbox && (
                  <button
                    className={"context-row" + (sandbox ? " context-on" : "")}
                    type="button"
                    onClick={onToggleSandbox}
                    aria-pressed={sandbox}
                    title="Run tools in an isolated Docker sandbox"
                  >
                    <span className="context-icon">
                      <Cube size={14} />
                    </span>
                    <span className="context-copy">
                      <span className="context-title">Sandbox</span>
                      <span className="context-value">
                        {sandbox ? "On" : "Off"}
                      </span>
                    </span>
                    <span className="context-switch" aria-hidden="true" />
                  </button>
                )}

                {showComputerUse && (
                  <button
                    className={
                      "context-row" + (computerUse ? " context-on" : "")
                    }
                    type="button"
                    onClick={onToggleComputer}
                    aria-pressed={computerUse}
                    title="Let the agent see the screen and control the mouse/keyboard"
                  >
                    <span className="context-icon">
                      <Monitor size={14} />
                    </span>
                    <span className="context-copy">
                      <span className="context-title">Computer use</span>
                      <span className="context-value">
                        {computerUse ? "On" : "Off"}
                      </span>
                    </span>
                    <span className="context-switch" aria-hidden="true" />
                  </button>
                )}

                <button
                  className={
                    "context-row" +
                    (toolApproval !== "guarded" ? " context-on" : "")
                  }
                  type="button"
                  onClick={onCycleToolApproval}
                  title={
                    toolApproval === "open"
                      ? "Open mode for Claude CLI uses Claude's bypass-permissions mode. Claude may run tools and commands without additional Claude prompts. Use only in trusted workspaces."
                      : "Cycle tool approval mode"
                  }
                >
                  <span className="context-icon">
                    <Shield size={14} />
                  </span>
                  <span className="context-copy">
                    <span className="context-title">Tool approval</span>
                    <span className="context-value">
                      {TOOL_APPROVAL_LABEL[toolApproval]}
                    </span>
                  </span>
                  <ChevronDown size={12} className="context-chev" />
                </button>

                <button
                  className={"context-row" + (memory ? " context-on" : "")}
                  type="button"
                  onClick={onToggleMemory}
                  aria-pressed={memory}
                  title="Let the agent use scoped thread and project memories"
                >
                  <span className="context-icon">
                    <Lightbulb size={14} />
                  </span>
                  <span className="context-copy">
                    <span className="context-title">Memory</span>
                    <span className="context-value">
                      {memory ? "On" : "Off"}
                    </span>
                  </span>
                  <span className="context-switch" aria-hidden="true" />
                </button>

                {showMemoryManager && (
                  <button
                    className="context-row"
                    type="button"
                    onClick={() => {
                      setMenu(null);
                      onManageMemory();
                    }}
                    title="Choose thread and project memory scope"
                  >
                    <span className="context-icon">
                      <Lightbulb size={14} />
                    </span>
                    <span className="context-copy">
                      <span className="context-title">Memory scope</span>
                      <span className="context-value">
                        Thread, project, all
                      </span>
                    </span>
                    <ChevronDown size={12} className="context-chev" />
                  </button>
                )}

                <button
                  className={
                    "context-row" + (privacy !== "off" ? " context-on" : "")
                  }
                  type="button"
                  onClick={onCyclePrivacy}
                  title="Scan PII before sending to a remote provider. Click to cycle Off, Redact, Block."
                >
                  <span className="context-icon">
                    <Shield size={14} />
                  </span>
                  <span className="context-copy">
                    <span className="context-title">Private mode</span>
                    <span className="context-value">
                      {PRIVACY_LABEL[privacy]}
                    </span>
                  </span>
                  <ChevronDown size={12} className="context-chev" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
