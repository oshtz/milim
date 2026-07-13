import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type {
  Agent,
  DelegationPolicy,
  Worker,
  WorkerDiffReview,
  WorkerPlanTask,
  WorkerRunStatus,
  WorkspaceGitActionResult,
} from "../api";
import type { SessionWorkerRunRecord } from "../sessions/store";
import { AgentAvatar } from "./AgentAvatar";
import { ArrowRight, Copy, Square, X } from "./icons";

const STATUS_LABEL: Record<WorkerRunStatus, string> = {
  proposed: "Needs approval",
  running: "Running",
  done: "Done",
  partial: "Partial",
  stopped: "Stopped",
  error: "Error",
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

export function WorkersInspector({
  record,
  policy,
  workerModel,
  modelOptions,
  agents,
  busy = false,
  closing = false,
  noEnterMotion = false,
  modeSwitcher,
  style,
  onPolicyChange,
  onWorkerModelChange,
  onStart,
  onStop,
  onContinueSolo,
  onStopWorker,
  onLoadDiff,
  onApplyDiff,
  onClose,
}: {
  record?: SessionWorkerRunRecord;
  policy: DelegationPolicy;
  workerModel: string;
  modelOptions: Array<{ id: string; label?: string }>;
  agents: Agent[];
  busy?: boolean;
  closing?: boolean;
  noEnterMotion?: boolean;
  modeSwitcher?: ReactNode;
  style?: CSSProperties;
  onPolicyChange: (policy: DelegationPolicy) => void;
  onWorkerModelChange: (model: string) => void;
  onStart: (runId: string) => void;
  onStop: (runId: string) => void;
  onContinueSolo: (runId: string) => void;
  onStopWorker: (runId: string, workerId: string) => Promise<void>;
  onLoadDiff: (runId: string, workerId: string) => Promise<WorkerDiffReview>;
  onApplyDiff: (runId: string, workerId: string) => Promise<WorkspaceGitActionResult>;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState("");
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [diffReview, setDiffReview] = useState<WorkerDiffReview>();
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewNotice, setReviewNotice] = useState("");
  const run = record?.run;
  const workers = record?.workers ?? [];
  const selectedWorker =
    workers.find((worker) => worker.id === selectedId) ?? workers[0];
  const selectedTask = selectedWorker
    ? taskForWorker(run?.tasks ?? [], selectedWorker)
    : undefined;

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

  const uniqueModels = useMemo(() => {
    const seen = new Set<string>();
    return modelOptions.filter((model) => model.id && !seen.has(model.id) && seen.add(model.id));
  }, [modelOptions]);

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
    <aside
      className={`preview-panel workers-panel${closing ? " closing" : ""}${noEnterMotion ? " no-enter" : ""}`}
      data-testid="workers-inspector"
      aria-label="Workers inspector"
      style={style}
    >
      <div className="preview-toolbar workers-toolbar">
        {modeSwitcher}
        <div className="preview-actions" aria-label="Worker run actions">
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
          <button
            className="preview-action"
            type="button"
            title="Close Workers inspector"
            aria-label="Close Workers inspector"
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="workers-controls">
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
        <label className="workers-model">
          <span>Worker model</span>
          <select
            value={workerModel}
            onChange={(event) => onWorkerModelChange(event.currentTarget.value)}
          >
            <option value="">Inherit parent</option>
            {uniqueModels.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label || model.id}
              </option>
            ))}
          </select>
        </label>
      </div>

      {!run ? (
        <div className="workers-empty">
          <strong>No worker runs yet</strong>
          <span>Delegated work will appear here without creating sidebar chats.</span>
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
                {taskAgent ? (
                  <AgentAvatar id={taskAgent.id} name={taskAgent.name} avatar={taskAgent.avatar} className="worker-agent-avatar" />
                ) : (
                  <span>{index + 1}</span>
                )}
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
                      <span className={taskAgent ? "worker-identity" : undefined}>
                        {taskAgent && <AgentAvatar id={taskAgent.id} name={taskAgent.name} avatar={taskAgent.avatar} className="worker-agent-avatar" />}
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
                    <div>
                      <span>{selectedTask?.role || selectedWorker.runtime}</span>
                      <strong>{selectedTask?.title || selectedWorker.title}</strong>
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
    </aside>
  );
}
