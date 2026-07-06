import { strict as assert } from "node:assert";
import type { ChatMessage } from "../src/api.js";
import { claimTurnGeneration, releaseTurnGeneration } from "../src/lib/turnStream.js";

const sessionId = "session-race";
const generationControllersRef = { current: new Map<string, AbortController>() };
const generating: Array<{ sessionId: string; running: boolean }> = [];
const store = {
  setSessionGenerating(targetSessionId: string, running: boolean) {
    generating.push({ sessionId: targetSessionId, running });
  },
};
const convo: ChatMessage[] = [{ role: "user", content: "hello" }];
let readinessRelease: (() => void) | null = null;
const delayedRuntimeReadiness = new Promise<void>((resolve) => {
  readinessRelease = resolve;
});

type RunTurnResult = {
  status: "done" | "skipped";
  messages: ChatMessage[];
  error?: string;
};

async function runTurnWithDelayedReadiness(): Promise<RunTurnResult> {
  const controller = claimTurnGeneration({ sessionId, store, generationControllersRef });
  if (!controller) {
    return { status: "skipped", messages: convo, error: "A turn is already running." };
  }
  try {
    await delayedRuntimeReadiness;
    return { status: "done", messages: convo };
  } finally {
    releaseTurnGeneration({ sessionId, store, generationControllersRef });
  }
}

const first = runTurnWithDelayedReadiness();
assert.equal(generationControllersRef.current.has(sessionId), true, "first turn should claim the session before runtime readiness resolves");
assert.deepEqual(generating, [{ sessionId, running: true }], "first turn should mark the session generating synchronously");

const second = await runTurnWithDelayedReadiness();
assert.equal(second.status, "skipped", "second rapid turn should be rejected while readiness is pending");
assert.equal(second.error, "A turn is already running.");
assert.deepEqual(generating, [{ sessionId, running: true }], "skipped turn should not toggle generating state");

readinessRelease?.();
const firstResult = await first;
assert.equal(firstResult.status, "done");
assert.equal(generationControllersRef.current.has(sessionId), false, "completed turn should release the session claim");
assert.deepEqual(generating, [
  { sessionId, running: true },
  { sessionId, running: false },
]);

export {};
