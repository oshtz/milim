import assert from "node:assert/strict";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { ChatMessage, WorkerRunRecord, WorkspaceGitStatus } from "../src/api.js";
import { DEFAULT_GOAL_SETTINGS } from "../src/lib/goals.js";
import { buildQuickSummary, type QuickSummary, type QuickSummaryRowKind } from "../src/lib/quickSummary.js";

type QuickSummaryPanelProps = {
  summary: QuickSummary;
  open: boolean;
  canOpenGit: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenGit: () => void;
  onOpenGoal: () => void;
  onOpenWorkers: () => void;
};

function gitStatus(patch: Partial<WorkspaceGitStatus> = {}): WorkspaceGitStatus {
  return {
    state: "ready",
    folder: "C:\\work\\milim",
    is_repo: true,
    root: "C:\\work\\milim",
    branch: "main",
    head: "abcdef123456",
    upstream: "origin/main",
    remote: "origin",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    insertions: 0,
    deletions: 0,
    has_changes: false,
    changed_file_count: 0,
    changed_files: [],
    branches: [],
    recent_commits: [],
    message: null,
    ...patch,
  };
}

function row(summary: QuickSummary, kind: QuickSummaryRowKind) {
  const match = summary.rows.find((item) => item.kind === kind);
  assert.ok(match, `Expected ${kind} row`);
  return match;
}

const empty = buildQuickSummary({
  folder: "",
  model: "",
  privacy: "off",
  memory: true,
  planMode: false,
  goal: DEFAULT_GOAL_SETTINGS,
  gitStatus: null,
  messages: [],
});

assert.deepEqual(
  empty.rows.map((item) => item.label),
  ["No workspace", "Model"],
);
assert.equal(row(empty, "workspace").value, "Pick a folder");
assert.equal(empty.sources.length, 0);

const clean = buildQuickSummary({
  folder: "C:\\work\\milim",
  model: "gpt-5",
  privacy: "redact",
  memory: false,
  planMode: false,
  goal: DEFAULT_GOAL_SETTINGS,
  gitStatus: gitStatus(),
  messages: [],
});

assert.equal(row(clean, "workspace").label, "milim");
assert.equal(row(clean, "workspace").value, "main - Clean");
assert.equal(row(clean, "workspace").tone, "ready");
assert.equal(row(clean, "model").value, "gpt-5");
assert.equal(row(clean, "privacy").value, "Redact");
assert.equal(row(clean, "memory").value, "Off");
assert.equal(clean.rows.some((item) => item.label === "Tools"), false);

const dirty = buildQuickSummary({
  folder: "C:\\work\\milim",
  model: "gpt-5",
  privacy: "off",
  memory: true,
  planMode: false,
  goal: DEFAULT_GOAL_SETTINGS,
  gitStatus: gitStatus({
    ahead: 2,
    insertions: 23,
    deletions: 4,
    has_changes: true,
    changed_file_count: 3,
  }),
  messages: [{ role: "assistant", content: "Plan", plan: { status: "proposed" } }],
  previewUrl: "http://localhost:5180/",
});

assert.equal(row(dirty, "workspace").tone, "warning");
assert.match(row(dirty, "workspace").value, /3 files/);
assert.match(row(dirty, "workspace").value, /\+23 -4/);
assert.match(row(dirty, "workspace").meta ?? "", /2 ahead \/ 0 behind/);
assert.equal(row(dirty, "plan").label, "Plan proposed");
assert.equal(row(dirty, "browser").value, "localhost:5180");

const sourceMessages: ChatMessage[] = [
  {
    role: "user",
    content: "Review the attached notes",
    attachments: [{ id: "a1", name: "notes.md", mime: "text/markdown", size: 10 }],
  },
  {
    role: "assistant",
    content: "Done",
    artifacts: [
      { id: "art1", kind: "code", title: "App.tsx", mime: "text/plain", content: "", size: 0 },
    ],
    memories: [
      {
        id: "m1",
        node_id: "n1",
        scope_kind: "thread",
        scope_label: "Thread",
        summary: "Prefers local models",
        created_at: "2026-07-09T00:00:00Z",
      },
    ],
  },
];

const active = buildQuickSummary({
  folder: "C:\\work\\milim",
  model: "codex",
  privacy: "block",
  memory: true,
  planMode: true,
  goal: { ...DEFAULT_GOAL_SETTINGS, objective: "Ship summary drawer", status: "running" },
  gitStatus: gitStatus({ conflicts: 1 }),
  messages: sourceMessages,
  pendingAttachments: [{ id: "p1", name: "todo.txt", mime: "text/plain", size: 4 }],
});

assert.match(row(active, "workspace").value, /1 conflict/);
assert.equal(row(active, "workspace").tone, "error");
assert.equal(active.rows.some((item) => item.kind === "plan"), false);
assert.equal(row(active, "goal").label, "Running goal");
assert.deepEqual(
  active.sources.map((source) => source.kind),
  ["attachment", "attachment", "artifact", "memory"],
);

const workerRun: WorkerRunRecord = {
  run: {
    id: "run-1",
    parent_thread_id: "thread-1",
    policy: "ask",
    runtime: "managed",
    status: "running",
    tasks: [
      { id: "task-1", title: "Inspect", prompt: "Inspect", model: "gpt-5", access: "read_only" },
    ],
    created_at: "2026-07-13T00:00:00Z",
    updated_at: "2026-07-13T00:00:00Z",
  },
  workers: [
    {
      id: "worker-1",
      parent_id: "thread-1",
      root_id: "thread-1",
      title: "Inspect",
      status: "running",
      model: "gpt-5",
      prompt: "Inspect",
      created_at: "2026-07-13T00:00:00Z",
      updated_at: "2026-07-13T00:00:00Z",
      runtime: "managed",
      access: "read_only",
    },
  ],
};

const withActivity = buildQuickSummary({
  folder: "C:\\work\\milim",
  model: "gpt-5",
  privacy: "off",
  memory: true,
  planMode: false,
  goal: DEFAULT_GOAL_SETTINGS,
  gitStatus: gitStatus(),
  workerRun,
  turnRunning: true,
  messages: [{
    role: "assistant",
    content: "",
    streamParts: [{ kind: "event", eventType: "tool", label: "Searching files", status: "running" }],
  }],
});
assert.equal(row(withActivity, "workers").value, "1 working");
assert.equal(row(withActivity, "activity").value, "1 tool running");
assert.equal(
  buildQuickSummary({
    folder: "",
    model: "gpt-5",
    privacy: "off",
    memory: true,
    planMode: false,
    goal: DEFAULT_GOAL_SETTINGS,
    gitStatus: null,
    workerRun: { ...workerRun, run: { ...workerRun.run, status: "done" } },
    turnRunning: false,
    messages: [{
      role: "assistant",
      content: "",
      streamParts: [{ kind: "event", eventType: "tool", label: "Searching files", status: "running" }],
    }],
  }).rows.some((item) => item.kind === "workers" || item.kind === "activity"),
  false,
);

const server = await createServer({
  root: process.cwd(),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const { QuickSummaryPanel } = await server.ssrLoadModule("/src/components/QuickSummaryPanel.tsx") as {
    QuickSummaryPanel: ComponentType<QuickSummaryPanelProps>;
  };
  const missingRowsMarkup = renderToStaticMarkup(
    createElement(QuickSummaryPanel, {
      summary: { sources: [] } as unknown as QuickSummary,
      open: true,
      canOpenGit: false,
      onOpenChange: () => {},
      onOpenGit: () => {},
      onOpenGoal: () => {},
      onOpenWorkers: () => {},
    }),
  );
  assert.match(missingRowsMarkup, /data-testid="quick-summary-panel"/);
  assert.match(missingRowsMarkup, />Sources</);
  assert.match(missingRowsMarkup, />None</);

  const groupedMarkup = renderToStaticMarkup(
    createElement(QuickSummaryPanel, {
      summary: {
        ...withActivity,
        rows: [...withActivity.rows, row(active, "goal")],
        sources: Array.from({ length: 7 }, (_, index) => ({
          kind: "attachment" as const,
          label: `source-${index + 1}`,
        })),
      },
      open: true,
      canOpenGit: true,
      onOpenChange: () => {},
      onOpenGit: () => {},
      onOpenGoal: () => {},
      onOpenWorkers: () => {},
    }),
  );
  for (const section of ["Environment", "Task", "Activity", "Context", "Sources"]) {
    assert.match(groupedMarkup, new RegExp(`>${section}<`));
  }
  assert.match(groupedMarkup, />2 more</);
  assert.match(groupedMarkup, /source-5/);
  assert.doesNotMatch(groupedMarkup, /source-6/);

  const closedMarkup = renderToStaticMarkup(
    createElement(QuickSummaryPanel, {
      summary: empty,
      open: false,
      canOpenGit: false,
      onOpenChange: () => {},
      onOpenGit: () => {},
      onOpenGoal: () => {},
      onOpenWorkers: () => {},
    }),
  );
  assert.match(closedMarkup, /aria-hidden="true"/);
  assert.doesNotMatch(closedMarkup, />Context</);
} finally {
  await server.close();
}
