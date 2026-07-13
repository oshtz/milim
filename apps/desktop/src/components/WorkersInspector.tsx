import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type {
  Agent,
  DelegationPolicy,
  ModelInfo,
  ProviderInfo,
  Worker,
  WorkerDiffReview,
  WorkerPlanTask,
  WorkerRunStatus,
  WorkspaceGitActionResult,
} from "../api";
import { modelDisplayName } from "../lib/modelPicker";
import type { SessionWorkerRunRecord } from "../sessions/store";
import { AgentAvatar } from "./AgentAvatar";
import { ArrowRight, Check, ChevronDown, Copy, Gear, Square } from "./icons";
import { ModelPicker } from "./ModelPicker";

const STATUS_LABEL: Record<WorkerRunStatus, string> = {
  proposed: "Needs approval",
  running: "Running",
  done: "Done",
  partial: "Partial",
  stopped: "Stopped",
  error: "Error",
};

const POLICY_DESCRIPTION: Record<DelegationPolicy, string> = {
  off: "The parent handles every task itself.",
  ask: "Review a worker plan before it runs.",
  auto: "Run independent tasks automatically.",
};

function elapsedLabel(start: string, end?: string | null, now = Date.now()) {
  const startedAt = Date.parse(start);
  const endedAt = end ? Date.parse(end) : now;
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return "";
  const seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function taskForWorker(
  tasks: WorkerPlanTask[],
  worker: Worker,
): WorkerPlanTask | undefined {
  return tasks.find(
    (task) =>
      task.id === worker.id ||
      task.prompt === worker.prompt ||
      task.title === worker.title,
  );
}

function workerResult(worker: Worker): string {
  return worker.summary?.trim() || worker.error?.trim() || "No result yet.";
}

function WorkerAvatar({
  agent,
  runId,
  identityId,
}: {
  agent?: Agent;
  runId: string;
  identityId: string;
}) {
  return agent ? (
    <AgentAvatar id={agent.id} name={agent.name} avatar={agent.avatar} className="worker-agent-avatar" />
  ) : (
    <AgentAvatar avatar={`worker:${runId}:${identityId}`} className="worker-agent-avatar" />
  );
}

export function WorkersInspector({
  record,
  policy,
  workerModel,
  models,
  providers,
  agents,
  busy = false,
  collapsed,
  onPolicyChange,
  onCollapsedChange,
  onWorkerModelChange,
  onStart,
  onStop,
  onContinueSolo,
  onStopWorker,
  onLoadDiff,
  onApplyDiff,
}: {
  record?: SessionWorkerRunRecord;
  policy: DelegationPolicy;
  workerModel: string;
  models: ModelInfo[];
  providers?: ProviderInfo[];
  agents: Agent[];
  busy?: boolean;
  collapsed: boolean;
  onPolicyChange: (policy: DelegationPolicy) => void;
  onCollapsedChange: (collapsed: boolean) => void;
  onWorkerModelChange: (model: string) => void;
  onStart: (runId: string) => void;
  onStop: (runId: string) => void;
  onContinueSolo: (runId: string) => void;
  onStopWorker: (runId: string, workerId: string) => Promise<void>;
  onLoadDiff: (runId: string, workerId: string) => Promise<WorkerDiffReview>;
  onApplyDiff: (runId: string, workerId: string) => Promise<WorkspaceGitActionResult>;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [diffReview, setDiffReview] = useState<WorkerDiffReview>();
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewNotice, setReviewNotice] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelPickerStyle, setModelPickerStyle] = useState<CSSProperties>();
  const modelPickerRef = useRef<HTMLDivElement>(null);
  const modelPickerMenuRef = useRef<HTMLDivElement>(null);
  const run = record?.run;
  const workers = record?.workers ?? [];
  const selectedWorker =
    workers.find((worker) => worker.id === selectedId) ?? workers[0];
  const selectedTask = selectedWorker
    ? taskForWorker(run?.tasks ?? [], selectedWorker)
    : undefined;
  const selectedAgent = agents.find((agent) => agent.id === selectedTask?.agent_id);
  const selectedModel = models.find((model) => model.id === workerModel);
  const workerModelLabel = workerModel
    ? selectedModel ? modelDisplayName(selectedModel) : workerModel
    : "Inherit parent";

  useEffect(() => {
    if (!selectedWorker && workers[0]) setSelectedId(workers[0].id);
  }, [selectedWorker, workers]);

  useEffect(() => {
    if (run?.status !== "running") return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [run?.status]);

  useEffect(() => {
    setDiffReview(undefined);
    setReviewNotice("");
  }, [selectedWorker?.id]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    const onDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(".mp-effort-menu")) return;
      if (
        target instanceof Node &&
        !modelPickerRef.current?.contains(target) &&
        !modelPickerMenuRef.current?.contains(target)
      ) {
        setModelPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocumentMouseDown);
    return () => document.removeEventListener("mousedown", onDocumentMouseDown);
  }, [modelPickerOpen]);

  function toggleModelPicker(button: HTMLButtonElement) {
    if (modelPickerOpen) {
      setModelPickerOpen(false);
      return;
    }
    const edge = 8;
    const gap = 6;
    const rect = button.getBoundingClientRect();
    const width = Math.min(440, window.innerWidth - edge * 2);
    const below = window.innerHeight - rect.bottom - edge - gap;
    const above = rect.top - edge - gap;
    const openBelow = below >= Math.min(320, above);
    const maxHeight = Math.max(160, Math.min(440, openBelow ? below : above));
    setModelPickerStyle({
      position: "fixed",
      left: Math.max(edge, Math.min(window.innerWidth - width - edge, rect.right - width)),
      top: openBelow ? rect.bottom + gap : rect.top - gap - maxHeight,
      width,
      maxHeight,
    });
    setModelPickerOpen(true);
  }

  function toggleSettings() {
    if (collapsed) onCollapsedChange(false);
    if (settingsOpen) setModelPickerOpen(false);
    setSettingsOpen(!settingsOpen);
  }

  function toggleSection() {
    if (!collapsed) {
      setSettingsOpen(false);
      setModelPickerOpen(false);
    }
    onCollapsedChange(!collapsed);
  }

  async function copyResult() {
    if (!selectedWorker || !navigator.clipboard) return;
    await navigator.clipboard.writeText(workerResult(selectedWorker));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  async function loadDiff() {
    if (!run || !selectedWorker) return;
    setReviewBusy(true);
    setReviewNotice("");
    try {
      setDiffReview(await onLoadDiff(run.id, selectedWorker.id));
    } catch (error) {
      setReviewNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setReviewBusy(false);
    }
  }

  async function applyDiff() {
    if (!run || !selectedWorker || !window.confirm("Apply this worker diff to the active workspace?")) return;
    setReviewBusy(true);
    try {
      const result = await onApplyDiff(run.id, selectedWorker.id);
      setReviewNotice(result.message);
    } catch (error) {
      setReviewNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setReviewBusy(false);
    }
  }

  return (
    <div
      className="workers-panel"
      data-testid="workers-inspector"
      aria-label="Workers"
    >
      <div className="workers-context-toolbar">
        <button
          className="workers-context-toggle"
          type="button"
          data-testid="workers-section-toggle"
          aria-expanded={!collapsed}
          aria-controls="workers-section-content"
          onClick={toggleSection}
        >
          <strong>Workers</strong>
          <span className="workers-context-summary">
            · {policy[0].toUpperCase() + policy.slice(1)} · {workerModelLabel}
          </span>
        </button>
        <div className="workers-context-actions">
          <button
            className="preview-action"
            type="button"
            data-testid="workers-settings-toggle"
            title="Worker settings"
            aria-label="Worker settings"
            aria-expanded={settingsOpen}
            aria-controls="workers-settings"
            onClick={toggleSettings}
          >
            <Gear size={12} />
          </button>
          <button
            className="preview-action workers-collapse-toggle"
            type="button"
            data-testid="workers-chevron-toggle"
            title={collapsed ? "Expand Workers" : "Collapse Workers"}
            aria-label={collapsed ? "Expand Workers" : "Collapse Workers"}
            aria-expanded={!collapsed}
            aria-controls="workers-section-content"
            onClick={toggleSection}
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
          {run?.status === "running" && (
            <button
              className="preview-action"
              type="button"
              disabled={busy}
              title="Stop all workers"
              aria-label="Stop all workers"
              onClick={() => onStop(run.id)}
            >
              <Square size={12} />
            </button>
          )}
        </div>
      </div>

      <div
        className="context-section-reveal"
        id="workers-section-content"
        data-collapsed={collapsed || undefined}
        aria-hidden={collapsed}
      >
      <div className="context-section-inner workers-section-content">
      {settingsOpen && (
        <div className="workers-controls" id="workers-settings">
          <div className="workers-control">
            <div className="workers-control-label">
              <span>Delegation</span>
              <small>{POLICY_DESCRIPTION[policy]}</small>
            </div>
            <div className="workers-policy" role="group" aria-label="Delegation policy">
              {(["off", "ask", "auto"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className={policy === value ? "active" : ""}
                  aria-pressed={policy === value}
                  onClick={() => onPolicyChange(value)}
                >
                  {value[0].toUpperCase() + value.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="workers-model">
            <span id="worker-model-label">Worker model</span>
            <div className="workers-model-picker" ref={modelPickerRef}>
              <button
                className="workers-model-trigger"
                type="button"
                data-testid="worker-model-picker-trigger"
                aria-labelledby="worker-model-label"
                aria-haspopup="dialog"
                aria-expanded={modelPickerOpen}
                onClick={(event) => toggleModelPicker(event.currentTarget)}
              >
                <span>{workerModelLabel}</span>
                <ChevronDown size={13} />
              </button>
              {modelPickerOpen && modelPickerStyle && createPortal(
                <div
                  ref={modelPickerMenuRef}
                  className="workers-model-menu"
                  data-native-preview-blocker="true"
                  role="dialog"
                  aria-label="Choose Worker model"
                  style={modelPickerStyle}
                >
                  <button
                    className={`workers-model-inherit${workerModel ? "" : " active"}`}
                    type="button"
                    aria-pressed={!workerModel}
                    onClick={() => {
                      onWorkerModelChange("");
                      setModelPickerOpen(false);
                    }}
                  >
                    <span>{!workerModel && <Check size={12} />}</span>
                    <strong>Inherit parent</strong>
                    <small>Use the model selected for this chat</small>
                  </button>
                  <ModelPicker
                    models={models}
                    model={workerModel}
                    providers={providers}
                    toolIntent
                    onModel={(selection) => onWorkerModelChange(selection.model)}
                    onManageProviders={() => {}}
                    onManageMcp={() => {}}
                    onManageMemory={() => {}}
                    onClose={() => setModelPickerOpen(false)}
                    showManagementActions={false}
                  />
                </div>,
                document.body,
              )}
            </div>
          </div>
        </div>
      )}

      {!run ? (
        <div className="workers-empty workers-empty-compact">
          <span>No runs yet</span>
        </div>
      ) : run.status === "proposed" ? (
        <div className="workers-plan" data-testid="workers-plan">
          <div className="workers-run-heading">
            <div>
              <span>Proposed run</span>
              <strong>{run.tasks.length} independent task{run.tasks.length === 1 ? "" : "s"}</strong>
            </div>
            <span className="workers-status proposed">{STATUS_LABEL.proposed}</span>
          </div>
          <div className="workers-plan-list">
            {run.tasks.map((task, index) => {
              const taskAgent = agents.find((agent) => agent.id === task.agent_id);
              return (
              <article key={task.id} className="workers-plan-task">
                <WorkerAvatar agent={taskAgent} runId={run.id} identityId={task.id} />
                <div>
                  <strong>{task.title || `Task ${index + 1}`}</strong>
                  <p>{task.prompt}</p>
                  <small>
                    {[task.role, task.model, task.access === "write_review" ? "reviewable write" : "read-only"]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </div>
              </article>
              );
            })}
          </div>
          <div className="workers-plan-actions">
            <button
              className="btn-accent"
              type="button"
              disabled={busy}
              onClick={() => onStart(run.id)}
            >
              <ArrowRight size={13} /> Run workers
            </button>
            <button
              className="btn-ghost"
              type="button"
              disabled={busy}
              onClick={() => onContinueSolo(run.id)}
            >
              Continue solo
            </button>
          </div>
        </div>
      ) : (
        <div className="workers-body">
          <div className="workers-run-heading">
            <div>
              <span>{run.runtime} run</span>
              <strong>{workers.length || run.tasks.length} worker{(workers.length || run.tasks.length) === 1 ? "" : "s"}</strong>
            </div>
            <span className={`workers-status ${run.status}`}>
              {STATUS_LABEL[run.status]}
              {run.status === "running" && ` · ${elapsedLabel(run.created_at, run.finished_at, now)}`}
            </span>
          </div>
          {workers.length ? (
            <div className="workers-split">
              <div className="workers-list" role="list" aria-label="Workers">
                {workers.map((worker) => {
                  const task = taskForWorker(run.tasks, worker);
                  const taskAgent = agents.find((agent) => agent.id === task?.agent_id);
                  return (
                    <button
                      key={worker.id}
                      type="button"
                      role="listitem"
                      className={worker.id === selectedWorker?.id ? "active" : ""}
                      onClick={() => setSelectedId(worker.id)}
                    >
                      <span className={`workers-dot ${worker.status}`} />
                      <span className="worker-identity">
                        <WorkerAvatar agent={taskAgent} runId={run.id} identityId={task?.id ?? worker.id} />
                        <strong>{task?.title || worker.title || "Worker"}</strong>
                        <small>{worker.model} · {worker.access === "write_review" ? "review write" : "read-only"}</small>
                      </span>
                      <em>{worker.status}</em>
                    </button>
                  );
                })}
              </div>
              {selectedWorker && (
                <section className="worker-detail" aria-label="Selected worker details">
                  <div className="worker-detail-head">
                    <div className="worker-detail-identity">
                      <WorkerAvatar agent={selectedAgent} runId={run.id} identityId={selectedTask?.id ?? selectedWorker.id} />
                      <div>
                        <span>{selectedTask?.role || selectedWorker.runtime}</span>
                        <strong>{selectedTask?.title || selectedWorker.title}</strong>
                      </div>
                    </div>
                    <button
                      className="preview-action"
                      type="button"
                      title={copied ? "Copied" : "Copy result"}
                      aria-label={copied ? "Copied" : "Copy worker result"}
                      onClick={() => void copyResult()}
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                  <p className="worker-task-prompt">{selectedTask?.prompt || selectedWorker.prompt}</p>
                  {selectedWorker.messages?.length ? (
                    <div className="worker-activity">
                      {selectedWorker.messages.map((message, index) => (
                        <div key={message.id ?? index} className={`worker-message ${message.role}`}>
                          <span>{message.role}</span>
                          <pre>{message.content}</pre>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <pre className="worker-result">{workerResult(selectedWorker)}</pre>
                  )}
                  {selectedWorker.worktree_path && (
                    <div className="worker-worktree">
                      <span>Review worktree</span>
                      <code>{selectedWorker.worktree_path}</code>
                      <div className="workers-plan-actions">
                        <button className="btn-ghost" type="button" disabled={reviewBusy} onClick={() => void loadDiff()}>
                          Review diff
                        </button>
                        {diffReview && (
                          <button className="btn-accent" type="button" disabled={reviewBusy || !diffReview.diff.trim()} onClick={() => void applyDiff()}>
                            Apply diff
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  {run.status === "running" && (selectedWorker.status === "queued" || selectedWorker.status === "running") && (
                    <button className="btn-ghost" type="button" disabled={reviewBusy} onClick={() => void onStopWorker(run.id, selectedWorker.id)}>
                      <Square size={12} /> Stop worker
                    </button>
                  )}
                  {diffReview && <pre className="worker-result worker-diff">{diffReview.diff || "No changes."}</pre>}
                  {reviewNotice && <p className="workers-run-error" role="status">{reviewNotice}</p>}
                </section>
              )}
            </div>
          ) : (
            <div className="workers-empty"><span>Waiting for workers to start...</span></div>
          )}
          {run.error && <div className="workers-run-error" role="alert">{run.error}</div>}
        </div>
      )}
      </div>
      </div>
    </div>
  );
}
