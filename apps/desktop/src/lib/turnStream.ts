import type { BufferedStreamChunk, useSessions } from "../sessions/store";
import { recordPerfMeasure } from "./perf.js";

const STREAM_UPDATE_BATCH_MS = 50;

export function createStreamUpdateBatcher(sessionId: string, store: ReturnType<typeof useSessions.getState>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: BufferedStreamChunk[] = [];

  const flush = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const chunks = pending;
    pending = [];
    recordPerfMeasure("stream.batchChunks", chunks.length);
    recordPerfMeasure("stream.batchChars", chunks.reduce((sum, chunk) => sum + chunk.content.length, 0));
    store.appendStreamChunks(sessionId, chunks);
  };

  const append = (chunk: BufferedStreamChunk) => {
    if (!chunk.content) return;
    const last = pending[pending.length - 1];
    if (last?.kind === chunk.kind) {
      pending[pending.length - 1] = { ...last, content: last.content + chunk.content };
    } else {
      pending.push(chunk);
    }
    timer ??= setTimeout(flush, STREAM_UPDATE_BATCH_MS);
  };

  return {
    appendToken: (text: string) => append({ kind: "text", content: text }),
    appendThinking: (text: string) => append({ kind: "thinking", content: text }),
    flush,
  };
}

type TurnGenerationStore = Pick<ReturnType<typeof useSessions.getState>, "setSessionGenerating">;

export function claimTurnGeneration({
  sessionId,
  store,
  generationControllersRef,
}: {
  sessionId: string;
  store: TurnGenerationStore;
  generationControllersRef: { current: Map<string, AbortController> };
}): AbortController | null {
  if (generationControllersRef.current.has(sessionId)) return null;
  const controller = new AbortController();
  generationControllersRef.current.set(sessionId, controller);
  store.setSessionGenerating(sessionId, true);
  return controller;
}

export function releaseTurnGeneration({
  sessionId,
  store,
  generationControllersRef,
}: {
  sessionId: string;
  store: TurnGenerationStore;
  generationControllersRef: { current: Map<string, AbortController> };
}) {
  generationControllersRef.current.delete(sessionId);
  store.setSessionGenerating(sessionId, false);
}

export function startTurnStream({
  sessionId,
  store,
  controller,
}: {
  sessionId: string;
  store: ReturnType<typeof useSessions.getState>;
  controller: AbortController;
}) {
  const streamBatcher = createStreamUpdateBatcher(sessionId, store);
  return {
    controller,
    streamBatcher,
    append: streamBatcher.appendToken,
    appendThinking: streamBatcher.appendThinking,
  };
}
