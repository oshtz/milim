import { previewControlActivityFromDebugUrl, previewControlActivityFromStreamParts } from "../src/lib/previewActivity.js";

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

const previewClick = previewControlActivityFromStreamParts([
  {
    kind: "event",
    eventType: "tool",
    label: "Using preview",
    name: "preview_click",
    status: "running",
  },
]);
assert(previewClick, "preview_click should create preview activity");
equal(previewClick.gesture, "click", "preview_click should map to click pulse");

const runtimeOnly = previewControlActivityFromStreamParts(undefined);
equal(runtimeOnly, null, "runtime busy without tool events should not show preview activity");

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
