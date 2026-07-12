import type { Agent, ChatMessage } from "../api";
import { useSessions } from "../sessions/store.js";
import { appendUserTurn } from "./turnContext.js";

export type TurnRunResult = {
  status: "done" | "aborted" | "error" | "skipped";
  messages: ChatMessage[];
  error?: string;
};

type ChatNotice = {
  message: string;
  tone: "info" | "warning" | "error";
};

type AgentModel = Pick<Agent, "id">;

export function queuedModelForSession(sessionId: string, fallback?: string, agents: AgentModel[] = []): string | null {
  const session = useSessions.getState().sessions.find((item) => item.id === sessionId);
  const settings = useSessions.getState().getSettings(sessionId);
  void agents;
  const selected = (session?.worker?.model || settings.model || fallback || "").trim();
  return selected || null;
}

export function hasQueuedMessages(sessionId: string): boolean {
  return Boolean(useSessions.getState().queuedMessagesBySession[sessionId]?.length);
}

export async function drainQueuedMessages({
  sessionId,
  fallbackModel,
  queueDrainRef,
  generationControllersRef,
  agents,
  setChatNotice,
  sessionMessages,
  runTurn,
}: {
  sessionId: string;
  fallbackModel?: string;
  queueDrainRef: { current: Set<string> };
  generationControllersRef: { current: Map<string, AbortController> };
  agents?: AgentModel[];
  setChatNotice: (notice: ChatNotice | null) => void;
  sessionMessages: (sessionId: string) => ChatMessage[];
  runTurn: (convo: ChatMessage[], selectedModel: string, sessionId: string) => Promise<TurnRunResult>;
}): Promise<void> {
  if (queueDrainRef.current.has(sessionId)) return;
  queueDrainRef.current.add(sessionId);
  try {
    for (;;) {
      if (generationControllersRef.current.has(sessionId)) return;
      const selectedModel = queuedModelForSession(sessionId, fallbackModel, agents);
      if (!selectedModel) {
        setChatNotice({ tone: "error", message: "Choose a model before running queued messages." });
        return;
      }
      const queued = useSessions.getState().shiftQueuedMessage(sessionId);
      if (!queued) return;
      const latest = sessionMessages(sessionId);
      const result = await runTurn(
        appendUserTurn(latest, queued.content, queued.attachments),
        selectedModel,
        sessionId,
      );
      if (result.status !== "done") return;
    }
  } finally {
    queueDrainRef.current.delete(sessionId);
  }
}
