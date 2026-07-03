import { strict as assert } from "node:assert";
import type { ChatStreamPart, WorkspaceCheckpoint, WorkspaceGitActionResult } from "../src/api.js";
import { checkpointWorkspaceBeforeTurn } from "../src/lib/turnWorkspace.js";

function gitResult(partial: Partial<WorkspaceGitActionResult>): WorkspaceGitActionResult {
  return {
    ok: false,
    action: "checkpoint",
    command: "git",
    stdout: "",
    stderr: "",
    exit_code: null,
    message: "",
    truncated: false,
    ...partial,
  };
}

const attached: WorkspaceCheckpoint[] = [];
const events: ChatStreamPart[] = [];
await checkpointWorkspaceBeforeTurn({
  sessionId: "s1",
  turnId: "turn-1",
  folder: " C:\\work ",
  planMode: false,
  useTools: true,
  accountRuntimeMayUseTools: false,
  setWorkspace: async (folder) => assert.equal(folder, "C:\\work"),
  runWorkspaceGitAction: async (action, options) => {
    assert.equal(action, "checkpoint");
    assert.equal(options.message, "turn-1");
    return gitResult({ ok: true, checkpoint: "refs/milim/checkpoints/s1", root: "C:\\work", head: "abc" });
  },
  attachCheckpoint: (_sessionId, checkpoint) => attached.push(checkpoint),
  appendStreamEvent: (_sessionId, part) => events.push(part),
  now: () => 123,
});
assert.deepEqual(attached, [{ ref: "refs/milim/checkpoints/s1", createdAt: 123, folder: "C:\\work", root: "C:\\work", head: "abc" }]);
assert.equal(events.length, 1);
assert.equal(events[0].kind, "event");
assert.match(events[0].kind === "event" ? events[0].label : "", /Workspace checkpoint/);

let called = false;
await checkpointWorkspaceBeforeTurn({
  sessionId: "s2",
  turnId: "turn-2",
  folder: "C:\\work",
  planMode: true,
  useTools: true,
  accountRuntimeMayUseTools: false,
  setWorkspace: async () => {
    called = true;
  },
  runWorkspaceGitAction: async () => gitResult({}),
  attachCheckpoint: () => {},
  appendStreamEvent: () => {},
});
assert.equal(called, false, "plan mode should skip workspace checkpoints");

const warnings: ChatStreamPart[] = [];
await checkpointWorkspaceBeforeTurn({
  sessionId: "s3",
  turnId: "turn-3",
  folder: "C:\\work",
  planMode: false,
  useTools: true,
  accountRuntimeMayUseTools: false,
  setWorkspace: async () => {},
  runWorkspaceGitAction: async () => gitResult({ ok: false, message: "permission denied" }),
  attachCheckpoint: () => assert.fail("failed checkpoint should not attach"),
  appendStreamEvent: (_sessionId, part) => warnings.push(part),
});
assert.equal(warnings.length, 1);
assert.equal(warnings[0].kind, "event");
assert.match(warnings[0].kind === "event" ? warnings[0].detail ?? "" : "", /permission denied/);
