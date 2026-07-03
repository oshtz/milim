import type { AgentMemoryContext, AgentToolContext, ChatMessage, MemoryScopeRef, SkillInfo, ToolApprovalMode } from "../api.js";
import { planModeInstructionMessages, threadArtifactInstructionMessages } from "./chatInstructions.js";
import { goalInstructionMessage, type GoalSettings } from "./goals.js";
import { skillInstructionMessage } from "./skills.js";

export type MemoryHit = {
  node: {
    scope_kind: string;
    title: string;
    body: string;
    kind: string;
  };
};

export type TurnPromptContext = {
  instructionMessages: ChatMessage[];
  planMessages: ChatMessage[];
  goalMessages: ChatMessage[];
  skillMessages: ChatMessage[];
  artifactMessages: ChatMessage[];
  memoryMessages: ChatMessage[];
  scheduleMessages: ChatMessage[];
  useScheduleTools: boolean;
  useTools: boolean;
  accountRuntimeMayUseTools: boolean;
  runMemoryContext: AgentMemoryContext;
  toolContext: AgentToolContext;
};

export type TurnContextMessageMode = "model" | "agent" | "tools";

export type TurnToolApprovalDecision =
  | { status: "not_required"; grant: false }
  | { status: "granted"; grant: true }
  | { status: "denied"; grant: false; error: string }
  | { status: "required"; grant: false; error: string };

type TurnPromptAgent = {
  skill_mode?: string;
  enabled_skills?: string[];
};

export function folderLabel(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).pop() || folder || "Project";
}

export function memoryScopes(threadId: string, folder: string): MemoryScopeRef[] {
  const scopes: MemoryScopeRef[] = [{ kind: "thread", locator: threadId }];
  if (folder.trim()) scopes.push({ kind: "project", locator: folder.trim() });
  return scopes;
}

export function buildTurnPromptContext({
  sessionId,
  threadTitle,
  folder,
  instructions,
  planMode,
  memory,
  conversation,
  lastUserText,
  memoryHits,
  selectedSkills,
  goal,
  turnId,
  codexModel,
  claudeModel,
  sandbox,
  computerUse,
  activeAgentId,
  toolApproval,
  toolApprovalGrant,
  experimentalHashlinePatch,
}: {
  sessionId: string;
  threadTitle: string;
  folder: string;
  instructions: string;
  planMode: boolean;
  memory: boolean;
  conversation: ChatMessage[];
  lastUserText?: string;
  memoryHits: MemoryHit[];
  selectedSkills: SkillInfo[];
  goal?: GoalSettings;
  turnId: string;
  codexModel?: string | null;
  claudeModel?: string | null;
  sandbox: boolean;
  computerUse: boolean;
  activeAgentId?: string | null;
  toolApproval: ToolApprovalMode;
  toolApprovalGrant: boolean;
  experimentalHashlinePatch: boolean;
}): TurnPromptContext {
  const skillMessage = skillInstructionMessage(selectedSkills);
  const memorySystem = memory && !planMode
    ? [
        memoryInstructions(sessionId, threadTitle, folder),
        memoryContextBlock(memoryHits),
      ].filter(Boolean).join("\n\n")
    : "";
  const instructionMessages: ChatMessage[] = instructions.trim()
    ? [{ role: "system", content: instructions.trim() }]
    : [];
  const goalMessage = goal ? goalInstructionMessage(goal) : null;
  const goalMessages: ChatMessage[] = goalMessage ? [goalMessage] : [];
  const planMessages = planModeInstructionMessages(planMode);
  const artifactMessages = threadArtifactInstructionMessages(folder);
  const skillMessages: ChatMessage[] = skillMessage ? [skillMessage] : [];
  const memoryMessages: ChatMessage[] = memorySystem
    ? [{ role: "system", content: memorySystem }]
    : [];
  const useScheduleTools = !planMode && looksLikeScheduleRequest(lastUserText ?? latestUserContent(conversation));
  const scheduleMessages: ChatMessage[] = useScheduleTools
    ? [{ role: "system", content: scheduleToolInstructions() }]
    : [];
  const runMemoryContext: AgentMemoryContext = {
    memory_enabled: memory && !planMode,
    thread_id: sessionId,
    thread_label: threadTitle,
    project_locator: folder.trim() || undefined,
    project_label: folder.trim() ? folderLabel(folder) : undefined,
    message_id: turnId,
  };
  const useTools = !codexModel && !claudeModel && (planMode || sandbox || computerUse || activeAgentId != null || folder.trim() !== "" || memory || useScheduleTools);
  const accountRuntimeMayUseTools = Boolean(codexModel || claudeModel) && !planMode;
  return {
    instructionMessages,
    planMessages,
    goalMessages,
    skillMessages,
    artifactMessages,
    memoryMessages,
    scheduleMessages,
    useScheduleTools,
    useTools,
    accountRuntimeMayUseTools,
    runMemoryContext,
    toolContext: {
      tool_approval_policy: toolApproval,
      tool_approval_grant: toolApprovalGrant,
      sandbox_enabled: sandbox,
      computer_use_enabled: computerUse,
      experimental_hashline_patch: experimentalHashlinePatch,
      plan_mode: planMode,
    },
  };
}

export async function prepareTurnPromptContext({
  sessionId,
  threadTitle,
  folder,
  instructions,
  planMode,
  memory,
  conversation,
  activeAgent,
  skills,
  goal,
  turnId,
  codexModel,
  claudeModel,
  model,
  sandbox,
  computerUse,
  activeAgentId,
  toolApproval,
  toolApprovalGrant,
  experimentalHashlinePatch,
  messageContent,
  searchMemory,
  selectSkills,
}: {
  sessionId: string;
  threadTitle: string;
  folder: string;
  instructions: string;
  planMode: boolean;
  memory: boolean;
  conversation: ChatMessage[];
  activeAgent: TurnPromptAgent | null;
  skills: SkillInfo[];
  goal?: GoalSettings;
  turnId: string;
  codexModel?: string | null;
  claudeModel?: string | null;
  model: string;
  sandbox: boolean;
  computerUse: boolean;
  activeAgentId?: string | null;
  toolApproval: ToolApprovalMode;
  toolApprovalGrant: boolean;
  experimentalHashlinePatch: boolean;
  messageContent: (message: ChatMessage) => string;
  searchMemory: (query: string, scopes: MemoryScopeRef[], limit: number, model?: string) => Promise<MemoryHit[]>;
  selectSkills: (query: string, limit: number) => Promise<SkillInfo[]>;
}): Promise<TurnPromptContext> {
  const lastUser = conversation
    .slice()
    .reverse()
    .find((message) => message.role === "user");
  const lastUserText = lastUser ? messageContent(lastUser) : "";
  const memoryHits = memory && !planMode && lastUser
    ? await searchMemory(lastUserText, memoryScopes(sessionId, folder), 5, codexModel || claudeModel ? undefined : model)
    : [];
  const selectedSkills = await skillsForTurn(activeAgent, lastUserText, skills, selectSkills);
  return buildTurnPromptContext({
    sessionId,
    threadTitle,
    folder,
    instructions,
    planMode,
    memory,
    conversation,
    lastUserText,
    memoryHits,
    selectedSkills,
    goal,
    turnId,
    codexModel,
    claudeModel,
    sandbox,
    computerUse,
    activeAgentId,
    toolApproval,
    toolApprovalGrant,
    experimentalHashlinePatch,
  });
}

export function contextMessagesForTurn(context: TurnPromptContext, mode: TurnContextMessageMode): ChatMessage[] {
  const instructions = mode === "agent" ? [] : context.instructionMessages;
  const schedules = mode === "model" ? [] : context.scheduleMessages;
  return [
    ...instructions,
    ...context.planMessages,
    ...context.goalMessages,
    ...context.skillMessages,
    ...context.artifactMessages,
    ...schedules,
    ...context.memoryMessages,
  ];
}

export function resolveTurnToolApproval({
  useTools,
  accountRuntimeMayUseTools,
  toolApproval,
  planMode,
  requestedGrant,
}: {
  useTools: boolean;
  accountRuntimeMayUseTools: boolean;
  toolApproval: ToolApprovalMode;
  planMode: boolean;
  requestedGrant?: boolean;
}): TurnToolApprovalDecision {
  const required = (useTools || accountRuntimeMayUseTools) && toolApproval === "review" && !planMode;
  if (!required) return { status: "not_required", grant: false };
  if (requestedGrant === true) return { status: "granted", grant: true };
  if (requestedGrant === false) return { status: "denied", grant: false, error: "Tool run canceled." };
  return { status: "required", grant: false, error: "Tool approval required." };
}

async function skillsForTurn(
  agent: TurnPromptAgent | null,
  lastUserText: string,
  skills: SkillInfo[],
  selectSkills: (query: string, limit: number) => Promise<SkillInfo[]>,
): Promise<SkillInfo[]> {
  if (!lastUserText) return [];
  if (agent?.skill_mode === "none") return [];
  if (agent?.skill_mode === "custom") {
    const wanted = new Set(agent.enabled_skills ?? []);
    return skills.filter((skill) => skill.enabled && wanted.has(skill.id));
  }
  return selectSkills(lastUserText, 3);
}

function memoryContextBlock(items: MemoryHit[]): string {
  if (items.length === 0) return "";
  const lines = items.map((hit, index) => {
    const node = hit.node;
    const body = node.body.trim() ? `: ${node.body.trim()}` : "";
    return `${index + 1}. [${node.scope_kind}/${node.kind}] ${node.title.trim()}${body}`;
  });
  return [
    "Relevant local memories for this turn:",
    ...lines,
    "",
    "Use these memories as context. Do not mention them unless they directly matter.",
  ].join("\n");
}

function memoryInstructions(threadId: string, threadTitle: string, folder: string): string {
  const project = folder.trim()
    ? `Current project memory scope: label="${folderLabel(folder)}", locator="${folder.trim()}".`
    : "No project folder is selected; use thread memory only.";
  return [
    "You can register durable local memories with the memory_register tool.",
    "Only save concise facts, decisions, preferences, project conventions, or unresolved tasks that are likely useful later.",
    `Current thread memory scope: label="${threadTitle || "Current thread"}", locator="${threadId}".`,
    project,
  ].join("\n");
}

function latestUserContent(messages: ChatMessage[]): string {
  return messages
    .slice()
    .reverse()
    .find((message) => message.role === "user")?.content ?? "";
}

function looksLikeScheduleRequest(input: string): boolean {
  const text = input.toLowerCase();
  if (!text.trim()) return false;
  const automationWords = /\b(automation|automations|schedule|scheduled|cron|recurring|repeat|periodic|hourly|daily|weekly)\b/;
  const recurringInterval = /\bevery\s+(\d+\s+)?(second|seconds|minute|minutes|hour|hours|day|days|weekday|weekdays|week|weeks|month|months)\b/;
  const actionWords = /\b(create|add|set up|setup|start|run|automate|schedule|list|show|open|update|change|pause|resume|disable|enable|delete|remove)\b/;
  return (automationWords.test(text) || recurringInterval.test(text)) && actionWords.test(text);
}

function scheduleToolInstructions(): string {
  return [
    "Milim can manage local cron automations with schedule_create, schedule_update, schedule_list, and schedule_delete.",
    "Use these tools when the user explicitly asks to create, update, list, pause, resume, or delete an automation.",
    "Never say an automation was saved unless the schedule tool succeeds.",
    "Cron uses six fields: sec min hour day month dow. For every N minutes use `0 */N * * * *`; for hourly use `0 0 * * * *`.",
  ].join(" ");
}
