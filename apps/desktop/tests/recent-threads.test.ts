import {
  nextRecentThreadSwitcherIndex,
  recentThreadSwitcherItems,
  rememberRecentThread,
  type RecentThreadProject,
  type RecentThreadSession,
} from "../src/lib/recentThreads.js";

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const sessions: RecentThreadSession[] = [
  { id: "current", title: "Current thread", settings: { folder: "C:\\repo\\milim", model: "gpt" } },
  { id: "last", title: "Last thread", settings: { folder: "C:\\repo\\milim", model: "claude" } },
  { id: "older", title: "Older thread", settings: { folder: "C:\\repo\\other" } },
  { id: "archived", title: "Archived thread", archivedAt: 1 },
  { id: "archived-project", title: "Archived project", settings: { folder: "C:\\repo\\old" } },
];

const projects: RecentThreadProject[] = [
  { folder: "C:\\repo\\milim", name: "milim" },
  { folder: "C:\\repo\\old", name: "old", archivedAt: 1 },
];

equal(
  rememberRecentThread(["current", "last", "older"], "last").join(","),
  "last,current,older",
  "remembering a thread should move it to the front without duplication",
);

equal(
  recentThreadSwitcherItems(["current"], "current", sessions, projects).length,
  0,
  "switcher should stay closed when there is no previous valid thread",
);

{
  const items = recentThreadSwitcherItems(
    ["current", "last", "archived", "archived-project", "older"],
    "current",
    sessions,
    projects,
    3,
  );

  equal(
    items.map((item) => item.id).join(","),
    "last,older,current",
    "switcher should show previous valid threads then the original active thread",
  );
  equal(items[0]?.metadata, "milim | claude", "metadata should include project and model");
  equal(items[1]?.metadata, "other", "metadata should fall back to folder label");
}

equal(nextRecentThreadSwitcherIndex(0, 3), 1, "cycle should advance");
equal(nextRecentThreadSwitcherIndex(2, 3), 0, "cycle should wrap");

export {};
