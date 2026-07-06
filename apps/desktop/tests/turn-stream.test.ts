import { strict as assert } from "node:assert";
import type { ChatMessage } from "../src/api.js";
import type { BufferedStreamChunk } from "../src/sessions/store.js";
import {
  claimTurnGeneration,
  createStreamUpdateBatcher,
  findStreamSmoothingBoundary,
  releaseTurnGeneration,
} from "../src/lib/turnStream.js";

const sessionId = "session-race";
const generationControllersRef = {
  current: new Map<string, AbortController>(),
};
const generating: Array<{ sessionId: string; running: boolean }> = [];
const store = {
  setSessionGenerating(targetSessionId: string, running: boolean) {
    generating.push({ sessionId: targetSessionId, running });
  },
};
const convo: ChatMessage[] = [{ role: "user", content: "hello" }];
let readinessReady = false;
async function delayedRuntimeReadiness(): Promise<void> {
  while (!readinessReady) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

type RunTurnResult = {
  status: "done" | "skipped";
  messages: ChatMessage[];
  error?: string;
};

async function runTurnWithDelayedReadiness(): Promise<RunTurnResult> {
  const controller = claimTurnGeneration({
    sessionId,
    store,
    generationControllersRef,
  });
  if (!controller) {
    return {
      status: "skipped",
      messages: convo,
      error: "A turn is already running.",
    };
  }
  try {
    await delayedRuntimeReadiness();
    return { status: "done", messages: convo };
  } finally {
    releaseTurnGeneration({ sessionId, store, generationControllersRef });
  }
}

const first = runTurnWithDelayedReadiness();
assert.equal(
  generationControllersRef.current.has(sessionId),
  true,
  "first turn should claim the session before runtime readiness resolves",
);
assert.deepEqual(
  generating,
  [{ sessionId, running: true }],
  "first turn should mark the session generating synchronously",
);

const second = await runTurnWithDelayedReadiness();
assert.equal(
  second.status,
  "skipped",
  "second rapid turn should be rejected while readiness is pending",
);
assert.equal(second.error, "A turn is already running.");
assert.deepEqual(
  generating,
  [{ sessionId, running: true }],
  "skipped turn should not toggle generating state",
);

readinessReady = true;
const firstResult = await first;
assert.equal(firstResult.status, "done");
assert.equal(
  generationControllersRef.current.has(sessionId),
  false,
  "completed turn should release the session claim",
);
assert.deepEqual(generating, [
  { sessionId, running: true },
  { sessionId, running: false },
]);

assert.equal(
  findStreamSmoothingBoundary("H"),
  0,
  "single graphemes should wait for a small visual burst",
);
assert.equal(
  findStreamSmoothingBoundary("Hello world"),
  "He".length,
  "smoothing should emit small grapheme bursts instead of whole words",
);
assert.equal(
  findStreamSmoothingBoundary("👨‍👩‍👧‍👦 family"),
  "👨‍👩‍👧‍👦 ".length,
  "smoothing should avoid splitting composed emoji graphemes when Intl.Segmenter is available",
);
assert.ok(
  findStreamSmoothingBoundary("a".repeat(256)) > "aa".length,
  "large buffered responses should emit larger adaptive bursts to catch up",
);
assert.equal(
  findStreamSmoothingBoundary("Short", { force: true }),
  "Short".length,
  "forced flush should release all buffered text exactly",
);

type AppendCall = {
  sessionId: string;
  messageIdOrChunks: string | BufferedStreamChunk[];
  chunks: BufferedStreamChunk[];
};

const appended: AppendCall[] = [];
const streamStore = {
  appendStreamChunks(
    targetSessionId: string,
    messageIdOrChunks: string | BufferedStreamChunk[],
    chunks: BufferedStreamChunk[],
  ) {
    appended.push({
      sessionId: targetSessionId,
      messageIdOrChunks,
      chunks: chunks.map((chunk) => ({ ...chunk })),
    });
  },
};

const batcher = createStreamUpdateBatcher(
  "smooth-session",
  "message-1",
  streamStore as never,
);
for (const char of "Hello world, this is streamed") {
  batcher.appendToken(char);
}
assert.equal(
  appended.length,
  0,
  "smoothing should not push per-character updates synchronously",
);
batcher.flush();
assert.equal(
  appended.length,
  1,
  "flush should drain smoothed text through the batcher",
);
assert.deepEqual(appended[0], {
  sessionId: "smooth-session",
  messageIdOrChunks: "message-1",
  chunks: [{ kind: "text", content: "Hello world, this is streamed" }],
});

appended.length = 0;
const mixedBatcher = createStreamUpdateBatcher(
  "smooth-session",
  "message-2",
  streamStore as never,
);
mixedBatcher.appendThinking("Thinking");
mixedBatcher.appendThinking(" through it.");
mixedBatcher.appendToken(" Final answer.");
mixedBatcher.flush();
assert.deepEqual(
  appended[0]?.chunks,
  [
    { kind: "thinking", content: "Thinking through it." },
    { kind: "text", content: " Final answer." },
  ],
  "flush should preserve thinking/text order and exact final content",
);

appended.length = 0;
const drainBatcher = createStreamUpdateBatcher(
  "smooth-session",
  "message-3",
  streamStore as never,
);
drainBatcher.appendToken(
  "This final answer should visibly drain instead of dumping.",
);
await drainBatcher.drain();
assert.ok(
  appended.length > 1,
  "drain should release buffered final text across multiple store updates",
);
assert.equal(
  appended
    .flatMap((call) => call.chunks)
    .map((chunk) => chunk.content)
    .join(""),
  "This final answer should visibly drain instead of dumping.",
  "drain should preserve exact final text content",
);

export {};
