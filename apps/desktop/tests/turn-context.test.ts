import { strict as assert } from "node:assert";
import type { ChatMessage, ModelInfo, ReasoningEffort } from "../src/api.js";
import { checkpointMessage } from "../src/lib/contextCompaction.js";
import { accountRuntimeNotReadyForTurn, accountRuntimeNotReadyTurn, accountRuntimeSelectionError, appendUserTurn, editResendConversation, prepareAndStartTurn, prepareTurnOutbound, regenerateTurnConversation, resolveTurnModel, resolveTurnSetup } from "../src/lib/turnContext.js";

const tinyModel: ModelInfo = { id: "tiny", owned_by: "Test", context_length: 1200 };
const effort: ReasoningEffort = "medium";

function user(content: string): ChatMessage {
  return { role: "user", content };
}

function assistant(content: string): ChatMessage {
  return { role: "assistant", content };
}

const attachment = [{ id: "a1", name: "note.txt", mime: "text/plain", size: 4, content: "test" }];
const appended = appendUserTurn([assistant("old")], "new", attachment);
assert.deepEqual(appended, [assistant("old"), { role: "user", content: "new", attachments: attachment }]);
const retryWithTrailingAssistants = [user("u1"), assistant("a1"), assistant("a2")];
assert.deepEqual(regenerateTurnConversation(retryWithTrailingAssistants), [retryWithTrailingAssistants[0]]);
const retryFromLatestUser = [user("u1"), assistant("a1"), user("u2")];
assert.deepEqual(regenerateTurnConversation(retryFromLatestUser), retryFromLatestUser);
assert.equal(regenerateTurnConversation([user("u1"), checkpointMessage("saved context", { auto: true, sourceTokens: 10 })]), null);
assert.equal(regenerateTurnConversation([assistant("orphan")]), null);
const edited = editResendConversation([{ role: "user", content: "old", attachments: attachment }, assistant("drop")], 0, " new ");
assert.deepEqual(edited, [{ role: "user", content: "new", attachments: attachment }]);
assert.equal(editResendConversation([user("old")], 0, "   "), null);
assert.equal(editResendConversation([user("old")], 2, "new"), null);

let requiredModelCalls = 0;
const requireModel = () => {
  requiredModelCalls += 1;
  return "required-model";
};
assert.deepEqual(resolveTurnModel({
  selectedModel: "selected-model",
  session: { worker: { model: "worker-model" } },
  activeAgent: { model: "agent-model" },
  settings: { model: "settings-model" },
  requireModel,
}), { ok: true, model: "selected-model" });
assert.deepEqual(resolveTurnModel({
  session: { worker: { model: " worker-model " } },
  activeAgent: { model: "agent-model" },
  settings: { model: "settings-model" },
  requireModel,
}), { ok: true, model: "worker-model" });
assert.deepEqual(resolveTurnModel({
  session: null,
  activeAgent: { model: " agent-model " },
  settings: { model: "settings-model" },
  requireModel,
}), { ok: true, model: "agent-model" });
assert.deepEqual(resolveTurnModel({
  session: null,
  activeAgent: null,
  settings: { model: " settings-model " },
  requireModel,
}), { ok: true, model: "settings-model" });
assert.deepEqual(resolveTurnModel({
  selectedModel: "",
  session: null,
  activeAgent: null,
  settings: { model: "" },
  requireModel,
}), { ok: true, model: "required-model" });
assert.equal(requiredModelCalls, 1);
assert.deepEqual(resolveTurnModel({
  session: null,
  activeAgent: null,
  settings: { model: "" },
  requireModel: () => "",
}), { ok: false, error: "No model selected." });

const setupSettings = {
  model: "thread-model",
  instructions: "Use tests.",
  folder: "C:\\work",
  sandbox: false,
  computerUse: false,
  memory: true,
  activeAgentId: "agent-1",
  toolApproval: "guarded" as const,
  planMode: false,
};
const setup = resolveTurnSetup({
  sessionId: "s1",
  sessions: [{ id: "s1", title: "Thread title", worker: null }],
  settings: setupSettings,
  agents: [{ id: "agent-1", model: "agent-model" }],
  activeTitle: "Active title",
  requireModel,
  codexRuntimeModel: () => null,
  claudeRuntimeModel: () => null,
  isCodexModel: () => false,
  isClaudeModel: () => false,
});
assert.equal(setup.ok, true);
if (setup.ok) {
  assert.equal(setup.model, "agent-model");
  assert.equal(setup.title, "Thread title");
  assert.equal(setup.settings, setupSettings);
  assert.equal(setup.activeAgent?.id, "agent-1");
}
assert.deepEqual(resolveTurnSetup({
  sessionId: "missing",
  selectedModel: "codex:",
  sessions: [],
  settings: { ...setupSettings, activeAgentId: null, model: "" },
  agents: [],
  activeTitle: "Active title",
  requireModel: () => "fallback",
  codexRuntimeModel: () => null,
  claudeRuntimeModel: () => null,
  isCodexModel: (model) => model.startsWith("codex:"),
  isClaudeModel: () => false,
}), { ok: false, error: "Choose a concrete Codex model." });

assert.equal(accountRuntimeSelectionError({
  model: "codex:",
  codexModel: null,
  claudeModel: null,
  isCodexModel: (model) => model.startsWith("codex:"),
  isClaudeModel: () => false,
}), "Choose a concrete Codex model.");
assert.equal(accountRuntimeSelectionError({
  model: "claude:",
  codexModel: null,
  claudeModel: null,
  isCodexModel: () => false,
  isClaudeModel: (model) => model.startsWith("claude:"),
}), "Choose a concrete Claude Code model.");
assert.equal(accountRuntimeSelectionError({
  model: "codex:gpt-5",
  codexModel: "gpt-5",
  claudeModel: null,
  isCodexModel: (model) => model.startsWith("codex:"),
  isClaudeModel: () => false,
}), null);
assert.equal(accountRuntimeNotReadyTurn({
  kind: "codex",
  ready: { ok: true },
  conversation: [user("hello")],
}), null);
const codexMissing = accountRuntimeNotReadyTurn({
  kind: "codex",
  ready: { ok: false, message: "CLI was not found on PATH", warning: true },
  conversation: [user("hello")],
});
assert.equal(codexMissing?.status, "skipped");
assert.equal(codexMissing?.error, "CLI was not found on PATH");
assert.equal(codexMissing?.messages[1].role, "assistant");
assert.equal(codexMissing?.messages[1].streamParts?.[0].kind, "event");
const claudeMissing = accountRuntimeNotReadyTurn({
  kind: "claude",
  ready: { ok: false, message: "not signed in" },
  conversation: [user("hello")],
});
assert.equal(claudeMissing?.status, "error");
assert.match(claudeMissing?.messages[1].content ?? "", /Claude Code is not ready/);
let runtimeChecks = "";
const codexCheck = await accountRuntimeNotReadyForTurn({
  codexModel: "gpt-5",
  claudeModel: null,
  conversation: [user("hello")],
  ensureCodexAccount: async () => {
    runtimeChecks += "codex";
    return { ok: false, message: "missing codex", warning: true };
  },
  ensureClaudeAccount: async () => assert.fail("claude should not be checked when codex runtime is selected"),
});
assert.equal(codexCheck?.status, "skipped");
assert.equal(codexCheck?.error, "missing codex");
assert.equal(runtimeChecks, "codex");
assert.equal(await accountRuntimeNotReadyForTurn({
  codexModel: null,
  claudeModel: null,
  conversation: [user("hello")],
  ensureCodexAccount: async () => assert.fail("codex should not be checked for model chat"),
  ensureClaudeAccount: async () => assert.fail("claude should not be checked for model chat"),
}), null);

const shortConversation = [user("hello"), assistant("hi")];
const idleRef = { current: false };
let checkpointCalls = 0;
const noCompaction = await prepareTurnOutbound({
  sessionId: "s1",
  contextMessages: [],
  conversation: shortConversation,
  model: "tiny",
  models: [tinyModel],
  folder: "C:\\work",
  reasoningEffort: effort,
  compactionInFlightRef: idleRef,
  setChatNotice: () => assert.fail("notice should not change without compaction"),
  createCompactionCheckpoint: async () => {
    checkpointCalls += 1;
    return checkpointMessage("unused", { auto: true, sourceTokens: 1 });
  },
  clearAccountRuntime: () => assert.fail("runtime should not reset without compaction"),
});
assert.equal(noCompaction.conversation, shortConversation);
assert.deepEqual(noCompaction.outbound, shortConversation);
assert.equal(checkpointCalls, 0);
assert.equal(idleRef.current, false);

const longConversation = [
  user("old user ".repeat(900)),
  assistant("old assistant ".repeat(900)),
  user("new user ".repeat(50)),
];
const notices: Array<string | null> = [];
const busyRef = { current: false };
const checkpointSources: ChatMessage[][] = [];
let clearedRuntime: string | null = null;
const compacted = await prepareTurnOutbound({
  sessionId: "s2",
  contextMessages: [],
  conversation: longConversation,
  model: "tiny",
  models: [tinyModel],
  folder: "C:\\work",
  reasoningEffort: effort,
  compactionInFlightRef: busyRef,
  setChatNotice: (notice) => notices.push(notice?.message ?? null),
  createCompactionCheckpoint: async (sessionId, sourceMessages, model, options) => {
    assert.equal(sessionId, "s2");
    assert.equal(model, "tiny");
    assert.equal(options.folder, "C:\\work");
    assert.equal(options.reasoningEffort, effort);
    assert.equal(options.auto, true);
    checkpointSources.push(sourceMessages);
    return checkpointMessage("Keep prior decisions.", { auto: true, sourceTokens: 100 });
  },
  clearAccountRuntime: (sessionId) => {
    clearedRuntime = sessionId;
  },
});

assert.equal(busyRef.current, false);
assert.equal(clearedRuntime, "s2");
assert.deepEqual(notices, ["Compacting thread context...", null]);
assert.equal(checkpointSources.length, 1);
assert.deepEqual(checkpointSources[0], longConversation.slice(0, 2));
assert.equal(compacted.conversation.length, 4);
assert.match(compacted.conversation[2].content, /Keep prior decisions/);
assert.equal(compacted.conversation[3], longConversation[2]);
assert(compacted.outbound.some((message) => message.content.includes("Previous thread context checkpoint")));

const order: string[] = [];
const started = await prepareAndStartTurn({
  contextMessages: [{ role: "system", content: "Use tests." }],
  conversation: shortConversation,
  prepareOutbound: async (contextMessages, conversation) => {
    order.push(`prepare:${contextMessages.length}:${conversation.length}`);
    return { conversation: [...conversation, assistant("prepared")], outbound: contextMessages };
  },
  beginAssistant: (conversation) => {
    order.push(`begin:${conversation.length}`);
  },
  checkpointWorkspace: async () => {
    order.push("checkpoint");
  },
  afterStart: () => {
    order.push("after");
  },
});
assert.deepEqual(order, ["prepare:1:2", "begin:3", "checkpoint", "after"]);
assert.deepEqual(started.outbound, [{ role: "system", content: "Use tests." }]);
