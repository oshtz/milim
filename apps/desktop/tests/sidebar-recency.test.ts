import { sessionRecencyLabel } from "../src/lib/sessionRecency.js";

function equal(actual: string, expected: string, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

const now = 1_800_000_000_000;

equal(sessionRecencyLabel(now - 30_000, now), "now", "fresh sessions should show now");
equal(sessionRecencyLabel(now - 5 * 60_000, now), "5m", "minute recency should use m");
equal(sessionRecencyLabel(now - 3 * 60 * 60_000, now), "3h", "hour recency should use h");
equal(sessionRecencyLabel(now - 6 * 24 * 60 * 60_000, now), "6d", "day recency should use d");
equal(sessionRecencyLabel(now - 45 * 24 * 60 * 60_000, now), "1mo", "older recency should use mo");

export {};
