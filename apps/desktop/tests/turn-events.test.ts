import type { BufferedStreamChunk } from "../src/sessions/store.js";
import { accountRuntimeToolPart, runtimeWarningMessage, statusPart, toolCompletedPart, toolStartedPart } from "../src/lib/turnEvents.js";
import { createStreamUpdateBatcher, startTurnStream } from "../src/lib/turnStream.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const started = toolStartedPart({
  type: "tool_call",
  name: "edit_file",
  call_id: "call-1",
  arguments: JSON.stringify({ path: "src/App.tsx" }),
} as never);
equal(started.callId, "call-1", "started tool part should preserve call id");
equal(started.label, "Editing file", "started edit_file label should be readable");
equal(started.detail, "src/App.tsx", "started tool part should show target path");

const completed = toolCompletedPart({
  type: "tool_result",
  name: "edit_file",
  call_id: "call-1",
  arguments: JSON.stringify({ path: "src/App.tsx" }),
  result: { added: 3, removed: 1 },
} as never);
equal(completed.callId, "call-1", "completed tool part should preserve call id");
equal(completed.label, "Edited file", "completed edit_file label should be readable");
equal(completed.detail, "src/App.tsx +3 -1", "completed tool part should include diff stats");

const failed = toolCompletedPart({
  type: "tool_result",
  name: "shell",
  call_id: "call-2",
  arguments: JSON.stringify({ command: "npm test" }),
  result: { error: "exit 1" },
} as never);
equal(failed.status, "error", "failed tool part should mark error status");
equal(failed.label, "Command failed", "failed shell tool should use error label");

const scroll = toolStartedPart({
  type: "tool_call",
  name: "scroll",
  call_id: "call-3",
  arguments: JSON.stringify({ delta_y: 400 }),
} as never);
equal(scroll.icon, "screen", "scroll should use the screen icon");
equal(scroll.label, "Using computer", "scroll should be grouped with computer-use tools");

const runtime = accountRuntimeToolPart({
  type: "tool",
  id: "tool-1",
  name: "shell",
  status: "running",
} as never);
equal(runtime.name, "tool-1", "account runtime tool should prefer runtime id");
equal(runtime.label, "Using shell", "account runtime tool should default running label");

const warning = runtimeWarningMessage("Codex not on PATH", "Install Codex");
assert(warning.streamParts?.[0]?.kind === "event", "runtime warning should be an event part");
equal(warning.streamParts[0].eventType, "warning", "runtime warning event should be warning");
equal(statusPart("Error", "boom", "error").status, "error", "error status part should mark error");

const appended: { sessionId: string; chunks: BufferedStreamChunk[] }[] = [];
const batcher = createStreamUpdateBatcher("s1", {
  appendStreamChunks: (sessionId: string, chunks: BufferedStreamChunk[]) => {
    appended.push({ sessionId, chunks });
  },
} as never);
batcher.appendToken("a");
batcher.appendToken("b");
batcher.appendThinking("c");
batcher.flush();

equal(appended.length, 1, "manual flush should append one batch");
equal(appended[0].sessionId, "s1", "batcher should append to the requested session");
equal(appended[0].chunks.length, 2, "batcher should merge adjacent chunks by kind");
equal(appended[0].chunks[0].content, "ab", "batcher should merge adjacent text tokens");
equal(appended[0].chunks[1].kind, "thinking", "batcher should keep thinking as a separate chunk");

const generating: Array<{ sessionId: string; value: boolean }> = [];
const controllers = { current: new Map<string, AbortController>() };
const startedChunks: BufferedStreamChunk[] = [];
const startedStream = startTurnStream({
  sessionId: "s2",
  generationControllersRef: controllers,
  store: {
    setSessionGenerating: (sessionId: string, value: boolean) => generating.push({ sessionId, value }),
    appendStreamChunks: (_sessionId: string, chunks: BufferedStreamChunk[]) => startedChunks.push(...chunks),
  } as never,
});
assert(controllers.current.get("s2") === startedStream.controller, "startTurnStream should register the controller");
equal(generating.length, 1, "startTurnStream should mark the session generating once");
equal(generating[0].sessionId, "s2", "startTurnStream should mark the requested session generating");
startedStream.append("x");
startedStream.appendThinking("y");
startedStream.streamBatcher.flush();
equal(startedChunks.length, 2, "startTurnStream append helpers should write through the batcher");
