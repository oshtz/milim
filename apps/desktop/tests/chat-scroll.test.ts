import { CHAT_SCROLL_BOTTOM_THRESHOLD, isNearScrollBottom } from "../src/lib/scroll.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(
  isNearScrollBottom({ scrollTop: 500, scrollHeight: 1_000, clientHeight: 500 }),
  "exact bottom should couple autoscroll",
);

assert(
  isNearScrollBottom({
    scrollTop: 500 - CHAT_SCROLL_BOTTOM_THRESHOLD,
    scrollHeight: 1_000,
    clientHeight: 500,
  }),
  "within threshold should couple autoscroll",
);

assert(
  !isNearScrollBottom({
    scrollTop: 500 - CHAT_SCROLL_BOTTOM_THRESHOLD - 1,
    scrollHeight: 1_000,
    clientHeight: 500,
  }),
  "farther than threshold should decouple autoscroll",
);
