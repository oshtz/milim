import { previewControlActivityFromDebugUrl, previewControlActivityFromStreamParts } from "../src/lib/previewActivity.js";
import type { PreviewAppStatus } from "../src/api.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const mouseMove = previewControlActivityFromStreamParts([
  {
    kind: "event",
    eventType: "tool",
    label: "Using computer",
    name: "mouse_move",
    callId: "move-1",
    status: "running",
  },
]);
assert(mouseMove, "mouse_move should create preview activity");
equal(mouseMove.gesture, "move", "mouse_move should map to cursor travel");
equal(mouseMove.status, "running", "running tool status should be preserved");

const click = previewControlActivityFromStreamParts([
  { kind: "text", content: "done" },
  {
    kind: "event",
    eventType: "tool",
    label: "Used computer",
    name: "mouse_click",
    callId: "click-1",
    status: "done",
  },
]);
assert(click, "mouse_click should create preview activity");
equal(click.gesture, "click", "mouse_click should map to click pulse");

const accountRuntimeLabel = previewControlActivityFromStreamParts([
  {
    kind: "event",
    eventType: "tool",
    label: "Using type_text",
    name: "runtime-tool-1",
    status: "running",
  },
]);
assert(accountRuntimeLabel, "account runtime labels should still be recognized");
equal(accountRuntimeLabel.gesture, "type", "type_text labels should map to typing");

const runtimeStatus: PreviewAppStatus = {
  thread_id: "thread-1",
  status: "starting",
  cwd: "",
  url: null,
  pid: null,
  command: null,
  message: "starting dev server",
  logs: [],
};
const runtime = previewControlActivityFromStreamParts(undefined, { runtimeBusy: true, runtimeStatus });
assert(runtime, "runtime busy should create preview activity");
equal(runtime.gesture, "inspect", "runtime busy should map to inspection glow");
equal(runtime.status, "running", "runtime busy should be running");

const ignored = previewControlActivityFromStreamParts([
  {
    kind: "event",
    eventType: "tool",
    label: "Command failed",
    name: "shell",
    status: "error",
  },
]);
equal(ignored, null, "unrelated errored tools should not show preview activity");

const debugUrl = previewControlActivityFromDebugUrl("http://localhost:5180/?previewActivity=click&previewActivityLabel=Testing");
assert(debugUrl, "localhost debug URL should create preview activity");
equal(debugUrl.gesture, "click", "debug URL should use the requested gesture");
equal(debugUrl.label, "Testing", "debug URL should preserve the requested label");
equal(debugUrl.status, "running", "debug URL activity should animate as running");

const blockedDebugUrl = previewControlActivityFromDebugUrl("https://example.com/?previewActivity=click");
equal(blockedDebugUrl, null, "debug URL should be localhost-only");

export {};
