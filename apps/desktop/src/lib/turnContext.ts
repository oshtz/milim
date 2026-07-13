import type {
  ChatMessage,
  DelegationPolicy,
  ModelInfo,
  ReasoningEffort,
  ToolApprovalMode,
} from "../api.js";
import {
  contextSendPlan,
  isCompactionCheckpoint,
  splitCompactionTail,
} from "./contextCompaction.js";
import { runtimeWarningMessage } from "./turnEvents.js";

export type TurnChatNotice = {
  message: string;
  tone: "info" | "warning" | "error";
};

export type PreparedTurnOutbound = {
  conversation: ChatMessage[];
  outbound: ChatMessage[];
};

export type PrepareTurnOutboundOptions = {
  skipAutoCompaction?: boolean;
  signal?: AbortSignal;
};

export type TurnModelResolution =
  { ok: true; model: string } | { ok: false; error: string };

export type AccountRuntimeReady =
  { ok: true } | { ok: false; message: string; warning?: boolean };

type TurnSetupSession = {
  title?: string;
  worker?: { model?: string | null } | null;
};

type TurnSetupSettings = {
  model: string;
  instructions: string;
  folder: string;
  sandbox: boolean;
  computerUse: boolean;
  memory: boolean;
  activeAgentId?: string | null;
  toolApproval: ToolApprovalMode;
  delegationPolicy: DelegationPolicy;
  workerModel: string;
  planMode: boolean;
};

type TurnSetupAgent = {
  id: string;
  model?: string | null;
  skill_mode?: string;
  enabled_skills?: string[];
};

export type TurnSetupResult =
  | {
      ok: true;
      session?: TurnSetupSession;
      settings: TurnSetupSettings;
      activeAgent: TurnSetupAgent | null;
      model: string;
      title: string;
      codexModel: string | null;
      claudeModel: string | null;
    }
  | { ok: false; error: string };

export function appendUserTurn(
  messages: readonly ChatMessage[],
  content: string,
  attachments?: ChatMessage["attachments"],
): ChatMessage[] {
  const message: ChatMessage = { role: "user", content };
  if (attachments !== undefined) message.attachments = attachments;
  return [...messages, message];
}

export function regenerateTurnConversation(
  messages: readonly ChatMessage[],
  isCheckpoint: (message: ChatMessage) => boolean = isCompactionCheckpoint,
): ChatMessage[] | null {
  let end = messages.length;
  while (
    end > 0 &&
    messages[end - 1].role === "assistant" &&
    !isCheckpoint(messages[end - 1])
  )
    end -= 1;
  if (end === 0 || isCheckpoint(messages[end - 1])) return null;
  return messages.slice(0, end);
}

export function editResendConversation(
  messages: readonly ChatMessage[],
  index: number,
  content: string,
): ChatMessage[] | null {
  const text = content.trim();
  if (!text || index < 0 || index >= messages.length) return null;
  return appendUserTurn(
    messages.slice(0, index),
    text,
    messages[index].attachments,
  );
}

export function resolveTurnModel({
  selectedModel,
  session,
  settings,
  requireModel,
}: {
  selectedModel?: string;
  session?: { worker?: { model?: string | null } | null } | null;
  activeAgent?: { model?: string | null } | null;
  settings: { model: string };
  requireModel: () => string | null;
}): TurnModelResolution {
  const configuredModel = (
    session?.worker?.model || settings.model
  ).trim();
  const model = (selectedModel ?? configuredModel) || requireModel();
  return model
    ? { ok: true, model }
    : { ok: false, error: "No model selected." };
}

export function resolveTurnSetup({
  sessionId,
  selectedModel,
  sessions,
  settings,
  agents,
  activeTitle,
  requireModel,
  codexRuntimeModel,
  claudeRuntimeModel,
  isCodexModel,
  isClaudeModel,
}: {
  sessionId: string;
  selectedModel?: string;
  sessions: Array<TurnSetupSession & { id: string }>;
  settings: TurnSetupSettings;
  agents: TurnSetupAgent[];
  activeTitle: string;
  requireModel: () => string | null;
  codexRuntimeModel: (model: string) => string | null;
  claudeRuntimeModel: (model: string) => string | null;
  isCodexModel: (model: string) => boolean;
  isClaudeModel: (model: string) => boolean;
}): TurnSetupResult {
  const session = sessions.find((item) => item.id === sessionId);
  const activeAgent = settings.activeAgentId
    ? (agents.find((agent) => agent.id === settings.activeAgentId) ?? null)
    : null;
  const resolvedModel = resolveTurnModel({
    selectedModel,
    session,
    activeAgent,
    settings,
    requireModel,
  });
  if (resolvedModel.ok === false)
    return { ok: false, error: resolvedModel.error };
  const model = resolvedModel.model;
  const codexModel = codexRuntimeModel(model);
  const claudeModel = claudeRuntimeModel(model);
  const runtimeError = accountRuntimeSelectionError({
    model,
    codexModel,
    claudeModel,
    isCodexModel,
    isClaudeModel,
  });
  if (runtimeError) return { ok: false, error: runtimeError };
  return {
    ok: true,
    session,
    settings,
    activeAgent,
    model,
    title: session?.title ?? activeTitle,
    codexModel,
    claudeModel,
  };
}

export function accountRuntimeSelectionError({
  model,
  codexModel,
  claudeModel,
  isCodexModel,
  isClaudeModel,
}: {
  model: string;
  codexModel?: string | null;
  claudeModel?: string | null;
  isCodexModel: (model: string) => boolean;
  isClaudeModel: (model: string) => boolean;
}): string | null {
  if (isCodexModel(model) && !codexModel)
    return "Choose a concrete Codex model.";
  if (isClaudeModel(model) && !claudeModel)
    return "Choose a concrete Claude CLI model.";
  return null;
}

export function accountRuntimeNotReadyTurn({
  kind,
  ready,
  conversation,
}: {
  kind: "codex" | "claude";
  ready: { ok: true } | { ok: false; message: string; warning?: boolean };
  conversation: ChatMessage[];
}): null | {
  status: "skipped" | "error";
  messages: ChatMessage[];
  error: string;
} {
  if (ready.ok === true) return null;
  const label =
    kind === "codex" ? "Codex not on PATH" : "Claude CLI not on PATH";
  const content =
    kind === "codex"
      ? "Codex is not ready. Check the login notice and resend when it completes."
      : "Claude CLI is not ready. Check the login notice and resend when it is signed in.";
  return {
    status: ready.warning ? "skipped" : "error",
    messages: [
      ...conversation,
      ready.warning
        ? runtimeWarningMessage(label, ready.message)
        : { role: "assistant", content },
    ],
    error: ready.message,
  };
}

export async function accountRuntimeNotReadyForTurn({
  codexModel,
  claudeModel,
  conversation,
  ensureCodexAccount,
  ensureClaudeAccount,
}: {
  codexModel?: string | null;
  claudeModel?: string | null;
  conversation: ChatMessage[];
  ensureCodexAccount: () => Promise<AccountRuntimeReady>;
  ensureClaudeAccount: () => Promise<AccountRuntimeReady>;
}): Promise<null | {
  status: "skipped" | "error";
  messages: ChatMessage[];
  error: string;
}> {
  if (codexModel)
    return accountRuntimeNotReadyTurn({
      kind: "codex",
      ready: await ensureCodexAccount(),
      conversation,
    });
  if (claudeModel)
    return accountRuntimeNotReadyTurn({
      kind: "claude",
      ready: await ensureClaudeAccount(),
      conversation,
    });
  return null;
}

export async function prepareAndStartTurn({
  contextMessages,
  conversation,
  prepareOutbound,
  beginAssistant,
  checkpointWorkspace,
  afterStart,
  prepareOptions,
}: {
  contextMessages: ChatMessage[];
  conversation: ChatMessage[];
  prepareOutbound: (
    contextMessages: ChatMessage[],
    conversation: ChatMessage[],
    options?: PrepareTurnOutboundOptions,
  ) => Promise<PreparedTurnOutbound>;
  beginAssistant: (conversation: ChatMessage[]) => void;
  checkpointWorkspace?: () => Promise<void>;
  afterStart?: () => void;
  prepareOptions?: PrepareTurnOutboundOptions;
}): Promise<PreparedTurnOutbound> {
  const prepared = await prepareOutbound(
    contextMessages,
    conversation,
    prepareOptions,
  );
  beginAssistant(prepared.conversation);
  if (checkpointWorkspace) await checkpointWorkspace();
  afterStart?.();
  return prepared;
}

export async function prepareTurnOutbound({
  sessionId,
  contextMessages,
  conversation,
  model,
  models,
  folder,
  reasoningEffort,
  compactionInFlightRef,
  setChatNotice,
  createCompactionCheckpoint,
  clearAccountRuntime,
  skipAutoCompaction,
  signal,
}: {
  sessionId: string;
  contextMessages: ChatMessage[];
  conversation: ChatMessage[];
  model: string;
  models: ModelInfo[];
  folder: string;
  reasoningEffort: ReasoningEffort;
  compactionInFlightRef: { current: boolean };
  setChatNotice: (notice: TurnChatNotice | null) => void;
  createCompactionCheckpoint: (
    sessionId: string,
    sourceMessages: ChatMessage[],
    model: string,
    options: {
      auto: boolean;
      folder: string;
      reasoningEffort: ReasoningEffort;
      signal?: AbortSignal;
    },
  ) => Promise<ChatMessage>;
  clearAccountRuntime: (sessionId: string) => void;
  skipAutoCompaction?: boolean;
  signal?: AbortSignal;
}): Promise<PreparedTurnOutbound> {
  if (skipAutoCompaction) {
    const plan = contextSendPlan(
      contextMessages,
      latestUserOrLast(conversation),
      model,
      models,
    );
    if (plan.error) throw new Error(plan.error);
    return { conversation, outbound: plan.messages };
  }

  let plan = contextSendPlan(contextMessages, conversation, model, models);
  if (plan.error) throw new Error(plan.error);
  if (!plan.shouldCompact) return { conversation, outbound: plan.messages };

  let latestUserIndex = -1;
  for (let i = conversation.length - 1; i >= 0; i -= 1) {
    if (conversation[i].role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex <= 0) return { conversation, outbound: plan.messages };

  compactionInFlightRef.current = true;
  setChatNotice({ tone: "info", message: "Compacting thread context..." });
  try {
    const beforeLatest = conversation.slice(0, latestUserIndex);
    const latestAndAfter = conversation.slice(latestUserIndex);
    const split = splitCompactionTail(beforeLatest, model, models);
    const checkpoint = await createCompactionCheckpoint(
      sessionId,
      split.head,
      model,
      {
        auto: true,
        folder,
        reasoningEffort,
        signal,
      },
    );
    const compactedConversation = [
      ...split.head,
      checkpoint,
      ...split.tail,
      ...latestAndAfter,
    ];
    plan = contextSendPlan(
      contextMessages,
      compactedConversation,
      model,
      models,
    );
    if (plan.error) throw new Error(plan.error);
    clearAccountRuntime(sessionId);
    setChatNotice(null);
    return { conversation: compactedConversation, outbound: plan.messages };
  } finally {
    compactionInFlightRef.current = false;
  }
}

function latestUserOrLast(messages: ChatMessage[]): ChatMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return [messages[i]];
  }
  return messages.slice(-1);
}
