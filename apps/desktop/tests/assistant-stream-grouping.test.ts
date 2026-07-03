import type { ChatStreamPart } from "../src/api.js";
import { groupCompletedStreamActivity } from "../src/lib/streamParts.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function tool(name: string, status: "done" | "running" | "error" = "done"): ChatStreamPart {
  return {
    kind: "event",
    eventType: "tool",
    label: status === "running" ? `Using ${name}` : status === "error" ? `${name} failed` : `Used ${name}`,
    name,
    icon: status === "error" ? "error" : "tool",
    status,
  };
}

const parts: ChatStreamPart[] = [
  { kind: "text", content: "before" },
  tool("read_file"),
  tool("list_dir"),
  { kind: "thinking", content: "checking" },
  tool("shell"),
  tool("edit_file", "error"),
  tool("write_file", "running"),
  { kind: "text", content: "after" },
];

const streaming = groupCompletedStreamActivity(parts, true);
equal(streaming.length, parts.length, "streaming mode should keep flat rows");
equal(streaming[1], parts[1], "streaming mode should preserve existing event objects");

const grouped = groupCompletedStreamActivity(parts, false);
equal(grouped.length, 5, "completed mode should collapse mixed internal activity");
equal(grouped[0].kind, "text", "text before tools should keep its order");
equal(grouped[1].kind, "workGroup", "tools and reasoning should become one work group");
if (grouped[1].kind === "workGroup") {
  equal(grouped[1].parts.length, 4, "work group should include successful tools and reasoning");
  assert(grouped[1].parts[0].kind === "event" && grouped[1].parts[0].name === "read_file", "work group should preserve first tool");
  assert(grouped[1].parts[2].kind === "thinking", "work group should preserve reasoning");
  assert(grouped[1].parts[3].kind === "event" && grouped[1].parts[3].name === "shell", "work group should preserve later tools");
}
assert(grouped[2].kind === "event" && grouped[2].status === "error", "failed tools should stay flat");
assert(grouped[3].kind === "event" && grouped[3].status === "running", "running tools should stay flat");
equal(grouped[4].kind, "text", "text after tools should keep its order");

const toolOnly = groupCompletedStreamActivity([tool("read_file"), tool("list_dir")], false);
equal(toolOnly.length, 1, "completed tool-only rows should still collapse to a tool group");
assert(toolOnly[0].kind === "toolGroup", "tool-only group should keep the compact tool label");
