import { strict as assert } from "node:assert";
import type { ChatStreamPart } from "../src/api.js";
import { liveWorkGroupSummary } from "../src/lib/streamParts.js";

function tool(
  label: string,
  status: "done" | "running" | "error",
): ChatStreamPart {
  return {
    kind: "event",
    eventType: "tool",
    label,
    name: "shell",
    icon: "command",
    status,
  };
}

const completedOnly = liveWorkGroupSummary({
  kind: "workGroup",
  parts: [tool("Ran command", "done")],
});
assert.equal(completedOnly?.label, "Ran command");
assert.equal(
  completedOnly?.status,
  "done",
  "completed tools should not render as still running while the answer streams",
);

const activeTool = liveWorkGroupSummary({
  kind: "workGroup",
  parts: [tool("Ran command", "done"), tool("Using Edit", "running")],
});
assert.equal(activeTool?.label, "Using Edit");
assert.equal(activeTool?.status, "running");

const reasoningAfterTool = liveWorkGroupSummary({
  kind: "workGroup",
  parts: [
    tool("Ran command", "done"),
    { kind: "thinking", content: "checking next step" },
  ],
});
assert.equal(reasoningAfterTool?.label, "reasoning...");
assert.equal(reasoningAfterTool?.status, "running");

export {};
