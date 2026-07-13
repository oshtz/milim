import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const server = await createServer({
  root: process.cwd(),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const api = (await server.ssrLoadModule("/src/api.ts")) as {
    agentAvatarSeed: (agent: { id?: string; name?: string; avatar?: string }) => string;
    parseAgentDraftResponse: (text: string) => { avatar: string };
  };
  const { AgentAvatar } = (await server.ssrLoadModule("/src/components/AgentAvatar.tsx")) as {
    AgentAvatar: ComponentType<{ id?: string; name?: string; avatar?: string; className?: string }>;
  };
  const { WorkersInspector } = (await server.ssrLoadModule("/src/components/WorkersInspector.tsx")) as {
    WorkersInspector: ComponentType<any>;
  };
  const { Select } = (await server.ssrLoadModule("/src/components/ui.tsx")) as {
    Select: ComponentType<any>;
  };

  equal(api.agentAvatarSeed({ name: "Researcher", avatar: "field-notes" }), "field-notes", "Explicit seeds should win");
  equal(api.agentAvatarSeed({ name: "Security", avatar: "🛡️" }), "🛡️", "Existing emoji should remain a compatible seed");
  equal(api.agentAvatarSeed({ name: "Researcher", avatar: "" }), "Researcher", "Blank seeds should follow the name");
  equal(api.agentAvatarSeed({ name: "Researcher", avatar: "/images/legacy.png" }), "Researcher", "Legacy images should follow the name");
  equal(api.agentAvatarSeed({ id: "agent-123" }), "agent-123", "Nameless records should fall back to their persisted ID");
  equal(api.agentAvatarSeed({}), "", "Seed resolution should never use a shared generic fallback");

  const draft = api.parseAgentDraftResponse(JSON.stringify({
    name: "Research Scout",
    avatar: "current-primary-sources",
    system_prompt: "Find current primary sources.",
  }));
  equal(draft.avatar, "current-primary-sources", "Generated seeds should not be truncated to initials");

  const props = { name: "Unsafe", avatar: '\"><script>alert(1)</script>' };
  const first = renderToStaticMarkup(createElement(AgentAvatar, props));
  const second = renderToStaticMarkup(createElement(AgentAvatar, props));
  equal(first, second, "Avatar element markup should be deterministic");
  assert(first.startsWith("<shatz-avatar"), "Agent avatars should use the shared custom element");
  assert(first.includes('shape="circle"'), "Agent avatars should use the circle recipe");
  assert(first.includes('secondary-color="'), "Agent avatars should set the seed-derived secondary color");
  assert(first.includes('background="'), "Agent avatars should set the seed-derived background color");
  assert(first.includes('aria-hidden="true"'), "Agent avatars paired with visible names should be decorative");
  assert(!first.includes("<script>"), "Seed text must remain escaped in markup");

  const coral = renderToStaticMarkup(createElement(AgentAvatar, { name: "Coral", avatar: "CR" }));
  const violet = renderToStaticMarkup(createElement(AgentAvatar, { name: "Violet", avatar: "WR" }));
  assert(coral !== violet, "Different seeds should produce varied avatar markup");
  assert(
    coral.match(/ color="([^"]+)"/)?.[1] !== violet.match(/ color="([^"]+)"/)?.[1],
    "Different seeds should select visibly different palettes",
  );

  const agent = {
    id: "agent-security",
    name: "Security Review",
    avatar: "security-seed",
    system_prompt: "Review security.",
    model: "",
    tool_mode: "none",
    enabled_tools: [],
    skill_mode: "none",
    enabled_skills: [],
  };
  const selectMarkup = renderToStaticMarkup(createElement(Select, {
    value: agent.id,
    onChange: () => {},
    options: [{ value: agent.id, label: agent.name, leading: createElement(AgentAvatar, agent) }],
  }));
  assert(selectMarkup.includes('data-avatar-seed="security-seed"'), "Agent selectors should render the shared avatar");

  const workerInspectorProps = {
    policy: "ask",
    workerModel: "",
    models: [],
    providers: [],
    agents: [agent],
    onPolicyChange: () => {},
    onWorkerModelChange: () => {},
    onStart: () => {},
    onStop: () => {},
    onContinueSolo: () => {},
    onStopWorker: async () => {},
    onLoadDiff: async () => ({ worker_id: "task-1", status: {}, diff: "" }),
    onApplyDiff: async () => ({ message: "" }),
  };
  const workerMarkup = renderToStaticMarkup(createElement(WorkersInspector, {
    ...workerInspectorProps,
    record: {
      run: {
        id: "run-1",
        parent_thread_id: "thread-1",
        policy: "ask",
        runtime: "managed",
        status: "proposed",
        tasks: [{ id: "task-1", title: "Security task", prompt: "Review.", agent_id: agent.id, model: "test", access: "read_only" }],
        created_at: "2026-07-13T00:00:00Z",
        updated_at: "2026-07-13T00:00:00Z",
      },
      workers: [],
    },
  }));
  assert(workerMarkup.includes('data-avatar-seed="security-seed"'), "Assigned Worker tasks should render their Agent avatar");

  const unassignedTasks = [
    { id: "task-a", title: "Inspect API", prompt: "Inspect the API.", model: "test", access: "read_only" },
    { id: "task-b", title: "Inspect UI", prompt: "Inspect the UI.", model: "test", access: "read_only" },
  ];
  const unassignedRun = {
    id: "run-2",
    parent_thread_id: "thread-1",
    policy: "ask",
    runtime: "managed",
    status: "proposed",
    tasks: unassignedTasks,
    created_at: "2026-07-13T00:00:00Z",
    updated_at: "2026-07-13T00:00:00Z",
  };
  const proposedMarkup = renderToStaticMarkup(createElement(WorkersInspector, {
    ...workerInspectorProps,
    agents: [],
    record: { run: unassignedRun, workers: [] },
  }));
  assert(proposedMarkup.includes('data-avatar-seed="worker:run-2:task-a"'), "Unassigned proposed tasks should receive deterministic avatars");
  assert(proposedMarkup.includes('data-avatar-seed="worker:run-2:task-b"'), "Different proposed tasks should receive different avatars");

  const runningMarkup = renderToStaticMarkup(createElement(WorkersInspector, {
    ...workerInspectorProps,
    agents: [],
    record: {
      run: { ...unassignedRun, status: "running" },
      workers: unassignedTasks.map((task, index) => ({
        id: `worker-${index + 1}`,
        parent_id: "thread-1",
        root_id: "thread-1",
        title: task.title,
        status: "running",
        model: task.model,
        prompt: task.prompt,
        created_at: "2026-07-13T00:00:00Z",
        updated_at: "2026-07-13T00:00:00Z",
        runtime: "managed",
        access: "read_only",
      })),
    },
  }));
  assert(runningMarkup.includes('data-avatar-seed="worker:run-2:task-a"'), "Live Workers should keep their proposed task avatar");
  assert(runningMarkup.includes('data-avatar-seed="worker:run-2:task-b"'), "Every live Worker should render a Shatz avatar");

  for (const policy of ["off", "ask", "auto"] as const) {
    const emptyMarkup = renderToStaticMarkup(createElement(WorkersInspector, {
      ...workerInspectorProps,
      policy,
      record: undefined,
    }));
    const policyLabel = policy[0].toUpperCase() + policy.slice(1);
    assert(emptyMarkup.includes(`${policyLabel} · Inherit parent`), `${policy} should appear in the compact summary`);
    assert(emptyMarkup.includes("No runs yet"), `${policy} should render the compact idle state`);
    assert(emptyMarkup.includes('data-testid="workers-settings-toggle"'), "Workers should render the settings disclosure");
    assert(emptyMarkup.includes('aria-expanded="false"'), "Worker settings should be collapsed by default");
    assert(!emptyMarkup.includes('data-testid="worker-model-picker-trigger"'), "Collapsed Worker settings should not occupy space");
    assert(!emptyMarkup.includes("<select"), "Workers should not render a native model select");
  }
} finally {
  await server.close();
}

export {};
