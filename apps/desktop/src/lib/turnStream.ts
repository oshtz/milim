import type { BufferedStreamChunk, useSessions } from "../sessions/store";
import { recordPerfMeasure } from "./perf.js";

const STREAM_UPDATE_BATCH_MS = 24;
const STREAM_SMOOTH_TICK_MS = 16;
const STREAM_SMOOTH_BASE_GRAPHEMES_PER_TICK = 2;
const STREAM_SMOOTH_MAX_GRAPHEMES_PER_TICK = 18;

type IntlSegment = {
  segment: string;
  index: number;
};

type IntlSegmenterLike = {
  segment(input: string): Iterable<IntlSegment>;
};

type IntlSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity?: "grapheme" | "word" | "sentence" },
) => IntlSegmenterLike;

type SmoothPendingChunk = BufferedStreamChunk & {
  offset: number;
};

const STREAM_SMOOTH_SEGMENT_WINDOW_CHARS = 256;
const STREAM_SMOOTH_COMPACT_AFTER_CHARS = 4096;

const streamGraphemeSegmenter = createGraphemeSegmenter();

function createGraphemeSegmenter(): IntlSegmenterLike | null {
  const Segmenter = (
    Intl as typeof Intl & { Segmenter?: IntlSegmenterConstructor }
  ).Segmenter;
  if (!Segmenter) return null;
  try {
    return new Segmenter(undefined, { granularity: "grapheme" });
  } catch {
    return null;
  }
}

function graphemesPerSmoothTick(bufferedChars: number): number {
  return Math.min(
    STREAM_SMOOTH_MAX_GRAPHEMES_PER_TICK,
    STREAM_SMOOTH_BASE_GRAPHEMES_PER_TICK + Math.floor(bufferedChars / 32),
  );
}

function findGraphemeBoundary(
  text: string,
  graphemes: number,
  start = 0,
): number {
  if (!text || graphemes <= 0 || start >= text.length) return 0;
  const view = text.slice(start, start + STREAM_SMOOTH_SEGMENT_WINDOW_CHARS);
  if (streamGraphemeSegmenter) {
    let count = 0;
    for (const segment of streamGraphemeSegmenter.segment(view)) {
      count += 1;
      if (count >= graphemes) {
        return start + segment.index + segment.segment.length;
      }
    }
    return 0;
  }
  const chars = Array.from(view);
  if (chars.length < graphemes) return 0;
  return start + chars.slice(0, graphemes).join("").length;
}

export function findStreamSmoothingBoundary(
  text: string,
  options: { force?: boolean; start?: number } = {},
): number {
  if (!text) return 0;
  if (options.force) return text.length;
  const start = options.start ?? 0;
  return findGraphemeBoundary(
    text,
    graphemesPerSmoothTick(text.length - start),
    start,
  );
}

export function createStreamUpdateBatcher(
  sessionId: string,
  messageIdOrStore: string | ReturnType<typeof useSessions.getState>,
  storeArg?: ReturnType<typeof useSessions.getState>,
) {
  const messageId =
    typeof messageIdOrStore === "string" ? messageIdOrStore : undefined;
  const store =
    typeof messageIdOrStore === "string" ? storeArg : messageIdOrStore;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let smoothTimer: ReturnType<typeof setTimeout> | null = null;
  let pending: BufferedStreamChunk[] = [];
  let smoothPending: SmoothPendingChunk[] = [];

  const flushBatch = () => {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length === 0) return;
    const chunks = pending;
    pending = [];
    recordPerfMeasure("stream.batchChunks", chunks.length);
    recordPerfMeasure(
      "stream.batchChars",
      chunks.reduce((sum, chunk) => sum + chunk.content.length, 0),
    );
    store?.appendStreamChunks(sessionId, messageId ?? chunks, chunks);
  };

  const appendBatch = (chunk: BufferedStreamChunk) => {
    if (!chunk.content) return;
    const last = pending[pending.length - 1];
    if (last?.kind === chunk.kind) {
      pending[pending.length - 1] = {
        ...last,
        content: last.content + chunk.content,
      };
    } else {
      pending.push(chunk);
    }
    timer ??= setTimeout(flushBatch, STREAM_UPDATE_BATCH_MS);
  };

  const clearSmoothTimer = () => {
    if (smoothTimer != null) {
      clearTimeout(smoothTimer);
      smoothTimer = null;
    }
  };

  const emitSmoothed = (force: boolean): boolean => {
    let emitted = false;
    while (smoothPending.length > 0) {
      const head = smoothPending[0];
      const boundary = findStreamSmoothingBoundary(head.content, {
        force,
        start: head.offset,
      });
      if (boundary <= head.offset) break;

      appendBatch({
        kind: head.kind,
        content: head.content.slice(head.offset, boundary),
      });
      emitted = true;

      if (boundary >= head.content.length) {
        smoothPending.shift();
      } else {
        head.offset = boundary;
        if (head.offset >= STREAM_SMOOTH_COMPACT_AFTER_CHARS) {
          head.content = head.content.slice(head.offset);
          head.offset = 0;
        }
        if (!force) break;
      }
    }
    return emitted;
  };

  const scheduleSmoothTick = () => {
    smoothTimer ??= setTimeout(() => {
      smoothTimer = null;
      emitSmoothed(false);
      if (smoothPending.length > 0) scheduleSmoothTick();
    }, STREAM_SMOOTH_TICK_MS);
  };

  const drain = async () => {
    clearSmoothTimer();
    while (smoothPending.length > 0) {
      const emitted = emitSmoothed(false);
      if (!emitted && smoothPending.length > 0) emitSmoothed(true);
      flushBatch();
      if (smoothPending.length === 0) break;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, STREAM_SMOOTH_TICK_MS),
      );
    }
    flushBatch();
  };

  const append = (chunk: BufferedStreamChunk) => {
    if (!chunk.content) return;
    const last = smoothPending[smoothPending.length - 1];
    if (last?.kind === chunk.kind) {
      if (last.offset >= STREAM_SMOOTH_COMPACT_AFTER_CHARS) {
        last.content = last.content.slice(last.offset);
        last.offset = 0;
      }
      smoothPending[smoothPending.length - 1] = {
        ...last,
        content: last.content + chunk.content,
      };
    } else {
      smoothPending.push({ ...chunk, offset: 0 });
    }
    emitSmoothed(false);
    if (smoothPending.length > 0) scheduleSmoothTick();
    else clearSmoothTimer();
  };

  const flush = () => {
    clearSmoothTimer();
    emitSmoothed(true);
    flushBatch();
  };

  return {
    appendToken: (text: string) => append({ kind: "text", content: text }),
    appendThinking: (text: string) =>
      append({ kind: "thinking", content: text }),
    drain,
    flush,
  };
}

type TurnGenerationStore = Pick<
  ReturnType<typeof useSessions.getState>,
  "setSessionGenerating"
>;

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
  messageId,
  store,
  controller,
}: {
  sessionId: string;
  messageId?: string;
  store: ReturnType<typeof useSessions.getState>;
  controller: AbortController;
}) {
  const streamBatcher = messageId
    ? createStreamUpdateBatcher(sessionId, messageId, store)
    : createStreamUpdateBatcher(sessionId, store);
  return {
    controller,
    streamBatcher,
    append: streamBatcher.appendToken,
    appendThinking: streamBatcher.appendThinking,
  };
}
