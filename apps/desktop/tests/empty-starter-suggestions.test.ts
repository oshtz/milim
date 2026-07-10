import assert from "node:assert/strict";
import type { WorkspaceGitStatus } from "../src/api.js";
import { buildEmptyStarterStrip } from "../src/lib/emptyStarterSuggestions.js";

function gitStatus(patch: Partial<WorkspaceGitStatus> = {}): WorkspaceGitStatus {
  return {
    state: "ready",
    folder: "C:\\work\\milim",
    is_repo: true,
    root: "C:\\work\\milim",
    branch: "main",
    head: "abc1234",
    upstream: "origin/main",
    remote: "origin",
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    insertions: 0,
    deletions: 0,
    has_changes: false,
    changed_file_count: 0,
    changed_files: [],
    branches: [],
    recent_commits: [
      { hash: "abc1234", subject: "Polish empty chat state" },
      { hash: "def5678", subject: "Add desktop verification" },
    ],
    message: null,
    ...patch,
  };
}

function assertThreeUnique(status: ReturnType<typeof buildEmptyStarterStrip>) {
  assert.equal(status.suggestions.length, 3);
  assert.equal(new Set(status.suggestions.map((suggestion) => suggestion.id)).size, 3);
}

const noFolder = buildEmptyStarterStrip("", null);
assertThreeUnique(noFolder);
assert.equal(noFolder.context, null);
assert.deepEqual(
  noFolder.suggestions.map((suggestion) => suggestion.label),
  ["Plan a feature", "Review pasted code", "Debug a failure"],
);

const loading = buildEmptyStarterStrip("C:\\work\\milim", null, true);
assert.equal(loading.loading, true);
assert.equal(loading.suggestions.length, 0);
assert.equal(loading.context, null);

const nonGit = buildEmptyStarterStrip(
  "C:\\work\\milim",
  gitStatus({ state: "not_git", is_repo: false, recent_commits: [] }),
);
assertThreeUnique(nonGit);
assert.equal(nonGit.context, null);
assert.equal(nonGit.suggestions[0].label, "Map this project");

const conflicts = buildEmptyStarterStrip(
  "C:\\work\\milim",
  gitStatus({
    conflicts: 2,
    has_changes: true,
    changed_file_count: 2,
    changed_files: [
      { status: "UU", path: "src/app.ts" },
      { status: "AA", path: "src/state.ts" },
    ],
  }),
);
assertThreeUnique(conflicts);
assert.equal(conflicts.suggestions[0].label, "Resolve conflicts");
assert.match(conflicts.suggestions[0].prompt, /src\/app\.ts/);
assert.match(conflicts.suggestions[0].prompt, /Re-check the repository state/);

const dirty = buildEmptyStarterStrip(
  "C:\\work\\milim",
  gitStatus({
    has_changes: true,
    changed_file_count: 4,
    unstaged: 4,
    insertions: 120,
    deletions: 18,
    changed_files: [
      { status: " M", path: "src/app.ts" },
      { status: " M", path: "src/styles.css" },
      { status: "??", path: "src/new.ts" },
    ],
  }),
);
assertThreeUnique(dirty);
assert.equal(dirty.suggestions[0].label, "Review changes");
assert.match(dirty.suggestions[0].detail, /\+120\/-18/);
assert.match(dirty.suggestions[0].prompt, /1 other file/);

const behind = buildEmptyStarterStrip(
  "C:\\work\\milim",
  gitStatus({ behind: 3 }),
);
assertThreeUnique(behind);
assert.equal(behind.suggestions[0].label, "Inspect incoming work");
assert.match(behind.suggestions[0].detail, /3 commits behind origin\/main/);

const ahead = buildEmptyStarterStrip(
  "C:\\work\\milim",
  gitStatus({ ahead: 2 }),
);
assertThreeUnique(ahead);
assert.equal(ahead.suggestions[0].label, "Review unpushed work");
assert.match(ahead.suggestions[0].prompt, /2 unpushed commits/);

const clean = buildEmptyStarterStrip("C:\\work\\milim", gitStatus());
assertThreeUnique(clean);
assert.deepEqual(
  clean.suggestions.map((suggestion) => suggestion.label),
  ["Continue latest work", "Review recent direction", "Find the next task"],
);
assert.match(clean.context, /main .* Clean .* latest abc1234/);
assert.match(clean.suggestions[0].prompt, /abc1234 Polish empty chat state/);
assert.match(clean.suggestions[1].prompt, /def5678 Add desktop verification/);

export {};
