import type { ChatStreamPart, McpAppDescriptor } from "../src/api.js";
import { mcpAppFallbackText, parseMcpAppArguments } from "../src/lib/mcpApps.js";
import { groupCompletedStreamActivity } from "../src/lib/streamParts.js";
import { toolCompletedPart } from "../src/lib/turnEvents.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const descriptor: McpAppDescriptor = {
  server_id: "fixture",
  resource_uri: "ui://fixture/chart",
  tool: { name: "show_chart", inputSchema: { type: "object" } },
};

assert(parseMcpAppArguments('{"value":1}').value === 1, "tool arguments should parse");
assert(Object.keys(parseMcpAppArguments("not json")).length === 0, "invalid arguments should be empty");
assert(
  mcpAppFallbackText({ content: [{ type: "text", text: "Fallback chart data" }] }) === "Fallback chart data",
  "text fallback should remain available when the app cannot load",
);

const appPart = toolCompletedPart({
  type: "tool_result",
  name: "show_chart",
  call_id: "call-1",
  arguments: "{}",
  result: { content: [{ type: "text", text: "fallback" }] },
  mcp_app: descriptor,
  mcp_app_result: { structuredContent: { values: [1, 2] }, content: [] },
});
assert(appPart.mcpApp === descriptor, "tool event should retain the app descriptor");
assert(appPart.mcpAppResult != null, "tool event should retain the full app result");
const parts: ChatStreamPart[] = [
  { kind: "event", eventType: "tool", label: "Used first", status: "done" },
  appPart,
  { kind: "event", eventType: "tool", label: "Used last", status: "done" },
];
const grouped = groupCompletedStreamActivity(parts, false);
assert(grouped.length === 3, "MCP App should remain at its exact transcript position");
assert(grouped[1].kind === "event" && grouped[1].mcpApp === descriptor, "MCP App should not enter a tool group");
