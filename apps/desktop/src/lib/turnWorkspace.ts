import type { ChatStreamPart, WorkspaceCheckpoint, WorkspaceGitActionResult } from "../api.js";
import { statusPart } from "./turnEvents.js";

type ChatStreamEventPart = Extract<ChatStreamPart, { kind: "event" }>;

export async function checkpointWorkspaceBeforeTurn({
  sessionId,
  turnId,
  folder,
  planMode,
  useTools,
  accountRuntimeMayUseTools,
  setWorkspace,
  runWorkspaceGitAction,
  attachCheckpoint,
  appendStreamEvent,
  now = () => Date.now(),
}: {
  sessionId: string;
  turnId: string;
  folder: string;
  planMode: boolean;
  useTools: boolean;
  accountRuntimeMayUseTools: boolean;
  setWorkspace: (folder: string) => Promise<unknown>;
  runWorkspaceGitAction: (action: "checkpoint", options: { message: string }) => Promise<WorkspaceGitActionResult>;
  attachCheckpoint: (sessionId: string, checkpoint: WorkspaceCheckpoint) => void;
  appendStreamEvent: (sessionId: string, part: ChatStreamEventPart) => void;
  now?: () => number;
}): Promise<void> {
  const workspaceFolder = folder.trim();
  if (!workspaceFolder || planMode || (!useTools && !accountRuntimeMayUseTools)) return;
  try {
    await setWorkspace(workspaceFolder);
    const result = await runWorkspaceGitAction("checkpoint", { message: turnId });
    if (!result.ok || !result.checkpoint) {
      if (!/No Git|No working folder/i.test(result.message)) {
        appendStreamEvent(sessionId, statusPart("Workspace checkpoint skipped", result.message, "warning"));
      }
      return;
    }
    attachCheckpoint(sessionId, {
      ref: result.checkpoint,
      createdAt: now(),
      folder: workspaceFolder,
      root: result.root,
      head: result.head,
    });
    appendStreamEvent(sessionId, statusPart("Workspace checkpoint", "Restore is available from this turn."));
  } catch (error) {
    appendStreamEvent(sessionId, statusPart("Workspace checkpoint skipped", String(error), "warning"));
  }
}
