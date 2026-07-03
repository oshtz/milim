import { GIT_STATUS_REFRESH_INTERVAL_MS, shouldRefreshGitStatus } from "../src/lib/gitRefresh.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(shouldRefreshGitStatus(null, 1_000), "missing run timestamp should refresh");
assert(!shouldRefreshGitStatus(1_000, 1_000 + GIT_STATUS_REFRESH_INTERVAL_MS - 1), "recent run should not refresh");
assert(shouldRefreshGitStatus(1_000, 1_000 + GIT_STATUS_REFRESH_INTERVAL_MS), "one minute old run should refresh");

export {};
