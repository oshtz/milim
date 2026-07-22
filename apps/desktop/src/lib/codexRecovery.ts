import type { CodexRecoveredThread } from "../api";
import type { Session } from "../sessions/store";

export function recoveredCodexSessionId(
  sessions: readonly Session[],
  threadId: string,
): string | null {
  return sessions.find((session) => session.accountRuntime?.codexThreadId === threadId)?.id ?? null;
}

export function recoveredCodexSession(thread: CodexRecoveredThread) {
  return {
    title: thread.title,
    messages: thread.messages,
    settings: { model: "", folder: thread.cwd ?? "" },
  };
}
