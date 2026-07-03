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

export function startTurnStream({
  sessionId,
  store,
  generationControllersRef,
}: {
  sessionId: string;
  store: ReturnType<typeof useSessions.getState>;
  generationControllersRef: { current: Map<string, AbortController> };
}) {
  const controller = new AbortController();
  generationControllersRef.current.set(sessionId, controller);
  store.setSessionGenerating(sessionId, true);
  const streamBatcher = createStreamUpdateBatcher(sessionId, store);
  return {
    controller,
    streamBatcher,
    append: streamBatcher.appendToken,
    appendThinking: streamBatcher.appendThinking,
  };
}
