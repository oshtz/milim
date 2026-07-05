import { strict as assert } from "node:assert";
import type { ChatMessage } from "../src/api.js";
import { buildTurnPromptContext, contextMessagesForTurn, folderLabel, memoryScopes, prepareTurnPromptContext, resolveTurnToolApproval } from "../src/lib/turnPrompt.js";

function user(content: string): ChatMessage {
  return { role: "user", content };
}

assert.equal(folderLabel("C:\\Users\\USER\\Documents\\DEV\\milim"), "milim");
assert.deepEqual(memoryScopes("thread-1", " C:\\work "), [
  { kind: "thread", locator: "thread-1" },
  { kind: "project", locator: "C:\\work" },
]);

const plain = buildTurnPromptContext({
  sessionId: "s1",
  threadTitle: "Thread",
  folder: "",
  instructions: " Be terse. ",
  planMode: false,
  memory: false,
  conversation: [user("hello")],
  memoryHits: [],
  selectedSkills: [],
  turnId: "turn-1",
  sandbox: false,
  computerUse: false,
  activeAgentId: null,
  toolApproval: "guarded",
  toolApprovalGrant: false,
  experimentalHashlinePatch: false,
});
assert.deepEqual(plain.instructionMessages, [{ role: "system", content: "Be terse." }]);
assert.equal(plain.artifactMessages.length, 1, "no-folder artifact guidance should stay in turn context");
assert.equal(plain.useTools, false);
assert.equal(plain.accountRuntimeMayUseTools, false);
assert.equal(contextMessagesForTurn(plain, "model")[0].content, "Be terse.");
assert.equal(contextMessagesForTurn(plain, "agent").some((message) => message.content === "Be terse."), false);

const previewTools = buildTurnPromptContext({
  sessionId: "s-preview",
  threadTitle: "Preview",
  folder: "",
  instructions: "",
  planMode: false,
  memory: false,
  conversation: [user("inspect the visible preview")],
  memoryHits: [],
  selectedSkills: [],
  turnId: "turn-preview",
  sandbox: false,
  computerUse: false,
  previewTools: true,
  activeAgentId: null,
  toolApproval: "guarded",
  toolApprovalGrant: false,
  experimentalHashlinePatch: false,
});
assert.equal(previewTools.useTools, true, "visible preview should enable scoped preview tools without computer-use");
assert.equal(previewTools.toolContext.computer_use_enabled, false);
assert.equal(previewTools.toolContext.preview_tools_enabled, true);

const virtualProject = buildTurnPromptContext({
  sessionId: "s1",
  threadTitle: "Thread",
  folder: "",
  instructions: "",
  planMode: false,
  memory: false,
  conversation: [user("why is the preview broken?")],
  memoryHits: [],
  selectedSkills: [],
  turnId: "turn-virtual",
  sandbox: false,
  computerUse: false,
  activeAgentId: null,
  toolApproval: "guarded",
  toolApprovalGrant: false,
  experimentalHashlinePatch: false,
  virtualProjectFiles: [{ path: "src/App.tsx", content: "export default function App() { return null; }" }],
});
assert.equal(virtualProject.artifactMessages.length, 2, "virtual project follow-ups should include file context");
assert.match(virtualProject.artifactMessages[1].content, /src\/App\.tsx/);

const scheduled = buildTurnPromptContext({
  sessionId: "s2",
  threadTitle: "Thread",
  folder: "",
  instructions: "",
  planMode: false,
  memory: false,
  conversation: [user("remind me")],
  lastUserText: "Create an automation every 5 minutes",
  memoryHits: [],
  selectedSkills: [],
  turnId: "turn-2",
  sandbox: false,
  computerUse: false,
  activeAgentId: null,
  toolApproval: "review",
  toolApprovalGrant: true,
  experimentalHashlinePatch: true,
});
assert.equal(scheduled.useScheduleTools, true);
assert.equal(scheduled.useTools, true);
assert.match(scheduled.scheduleMessages[0].content, /schedule_create/);
assert.equal(scheduled.toolContext.tool_approval_grant, true);
assert.equal(scheduled.toolContext.experimental_hashline_patch, true);
assert.equal(contextMessagesForTurn(scheduled, "model").some((message) => message.content.includes("schedule_create")), false);
assert.equal(contextMessagesForTurn(scheduled, "tools").some((message) => message.content.includes("schedule_create")), true);

const memory = buildTurnPromptContext({
  sessionId: "s3",
  threadTitle: "Memory Thread",
  folder: "",
  instructions: "",
  planMode: false,
  memory: true,
  conversation: [user("continue")],
  memoryHits: [{ node: { scope_kind: "project", kind: "decision", title: "Use SQLite", body: "Local first." } }],
  selectedSkills: [{ id: "sk1", name: "Skill", description: "Useful", instructions: "Do it.", enabled: true, source_kind: "local" }],
  turnId: "turn-3",
  sandbox: false,
  computerUse: false,
  activeAgentId: null,
  toolApproval: "guarded",
  toolApprovalGrant: false,
  experimentalHashlinePatch: false,
});
assert.equal(memory.useTools, false, "retrieved memory alone should stay on the cheap model-chat path");
assert.equal(memory.runMemoryContext.memory_enabled, false);
assert.match(memory.memoryMessages[0].content, /Relevant local memories/);
assert.doesNotMatch(memory.memoryMessages[0].content, /memory_register/);
assert.match(memory.skillMessages[0].content, /## 1\. Skill/);
assert.equal(memory.runMemoryContext.project_label, undefined);

const explicitMemoryWrite = buildTurnPromptContext({
  sessionId: "s3-write",
  threadTitle: "Memory Thread",
  folder: "",
  instructions: "",
  planMode: false,
  memory: true,
  conversation: [user("remember this preference")],
  memoryHits: [],
  selectedSkills: [],
  turnId: "turn-3-write",
  sandbox: false,
  computerUse: false,
  activeAgentId: null,
  toolApproval: "guarded",
  toolApprovalGrant: false,
  experimentalHashlinePatch: false,
});
assert.equal(explicitMemoryWrite.useTools, true, "explicit memory writes should enable the agent tool path");
assert.equal(explicitMemoryWrite.runMemoryContext.memory_enabled, true);
assert.match(explicitMemoryWrite.memoryMessages[0].content, /memory_register/);
assert.equal(contextMessagesForTurn(explicitMemoryWrite, "agent").some((message) => message.content.includes("Current thread memory scope")), true);

const accountRuntime = buildTurnPromptContext({
  sessionId: "s4",
  threadTitle: "Runtime",
  folder: "C:\\repo",
  instructions: "",
  planMode: false,
  memory: false,
  conversation: [user("edit files")],
  memoryHits: [],
  selectedSkills: [],
  turnId: "turn-4",
  codexModel: "gpt-5",
  sandbox: true,
  computerUse: true,
  activeAgentId: null,
  toolApproval: "review",
  toolApprovalGrant: false,
  experimentalHashlinePatch: false,
});
assert.equal(accountRuntime.useTools, false);
assert.equal(accountRuntime.accountRuntimeMayUseTools, true);

const searched: Array<{ query: string; scopes: unknown[]; limit: number; model?: string }> = [];
const selectedQueries: Array<{ query: string; limit: number }> = [];
const prepared = await prepareTurnPromptContext({
  sessionId: "s5",
  threadTitle: "Prepared",
  folder: "C:\\repo",
  instructions: "",
  planMode: false,
  memory: true,
  conversation: [user("remember this")],
  activeAgent: { skill_mode: "custom", enabled_skills: ["custom-skill"] },
  skills: [
    { id: "custom-skill", name: "Custom", description: "", instructions: "Use custom.", enabled: true, source_kind: "local" },
    { id: "disabled-skill", name: "Disabled", description: "", instructions: "Skip.", enabled: false, source_kind: "local" },
  ],
  turnId: "turn-5",
  model: "local-model",
  sandbox: false,
  computerUse: false,
  activeAgentId: "agent-1",
  toolApproval: "guarded",
  toolApprovalGrant: false,
  experimentalHashlinePatch: false,
  messageContent: (message) => `${message.content} with attachments`,
  searchMemory: async (query, scopes, limit, model) => {
    searched.push({ query, scopes, limit, model });
    return [{ node: { scope_kind: "thread", kind: "note", title: "Saved", body: "Memory body" } }];
  },
  selectSkills: async (query, limit) => {
    selectedQueries.push({ query, limit });
    return [];
  },
});
assert.equal(searched[0].query, "remember this with attachments");
assert.equal(searched[0].limit, 5);
assert.equal(searched[0].model, "local-model");
assert.deepEqual(searched[0].scopes, [
  { kind: "thread", locator: "s5" },
  { kind: "project", locator: "C:\\repo" },
]);
assert.equal(selectedQueries.length, 0, "custom agent skills should not call auto skill selection");
assert.match(prepared.memoryMessages[0].content, /Memory body/);
assert.match(prepared.skillMessages[0].content, /Custom/);
assert.equal(prepared.useTools, true);

const accountPrepared = await prepareTurnPromptContext({
  sessionId: "s6",
  threadTitle: "Account",
  folder: "C:\\repo",
  instructions: "",
  planMode: false,
  memory: true,
  conversation: [user("use account runtime")],
  activeAgent: null,
  skills: [],
  turnId: "turn-6",
  codexModel: "gpt-5",
  model: "codex:gpt-5",
  sandbox: false,
  computerUse: false,
  activeAgentId: null,
  toolApproval: "review",
  toolApprovalGrant: false,
  experimentalHashlinePatch: false,
  messageContent: (message) => message.content,
  searchMemory: async (_query, _scopes, _limit, model) => {
    searched.push({ query: "account", scopes: [], limit: 0, model });
    return [];
  },
  selectSkills: async (query, limit) => {
    selectedQueries.push({ query, limit });
    return [];
  },
});
assert.equal(searched.at(-1)?.model, undefined, "account-runtime memory search should use default memory model");
assert.equal(selectedQueries.at(-1)?.query, "use account runtime");
assert.equal(accountPrepared.accountRuntimeMayUseTools, true);

assert.deepEqual(resolveTurnToolApproval({
  useTools: false,
  accountRuntimeMayUseTools: false,
  toolApproval: "review",
  planMode: false,
}), { status: "not_required", grant: false });
assert.deepEqual(resolveTurnToolApproval({
  useTools: true,
  accountRuntimeMayUseTools: false,
  toolApproval: "review",
  planMode: false,
  requestedGrant: true,
}), { status: "granted", grant: true });
assert.deepEqual(resolveTurnToolApproval({
  useTools: false,
  accountRuntimeMayUseTools: true,
  toolApproval: "review",
  planMode: false,
  requestedGrant: false,
}), { status: "denied", grant: false, error: "Tool run canceled." });
assert.deepEqual(resolveTurnToolApproval({
  useTools: true,
  accountRuntimeMayUseTools: false,
  toolApproval: "review",
  planMode: false,
}), { status: "required", grant: false, error: "Tool approval required." });
assert.equal(resolveTurnToolApproval({
  useTools: true,
  accountRuntimeMayUseTools: false,
  toolApproval: "review",
  planMode: true,
}).status, "not_required");
