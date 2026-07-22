import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import type { ChatStreamPart } from "../src/api.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const server = await createServer({
  root: process.cwd(),
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const { AssistantMessage } = (await server.ssrLoadModule(
    "/src/components/AssistantMessage.tsx",
  )) as { AssistantMessage: ComponentType<{ content: string; streamParts: ChatStreamPart[] }> };

  const renderApproval = (approvalRequest: Extract<ChatStreamPart, { kind: "event" }>["approvalRequest"]) =>
    renderToStaticMarkup(createElement(AssistantMessage, {
      content: "",
      streamParts: [{
        kind: "event",
        eventType: "status",
        label: "Approval",
        status: "done",
        approvalId: "approval-1",
        approvalStatus: "pending",
        approvalRequest,
      }],
    }));

  const form = renderApproval({
    kind: "mcp_form",
    server_name: "example",
    message: "Choose values",
    fields: [
      { name: "name", label: "Name", kind: "string", required: true },
      { name: "tone", label: "Tone", kind: "enum", required: true, options: [{ value: "calm", label: "Calm" }] },
    ],
  });
  assert(form.includes("Choose values"), "MCP form message should render");
  assert(form.includes("Name *"), "required MCP form fields should render");
  assert(form.includes("<select"), "enum MCP form fields should use a native select");
  assert(form.includes(">Submit<"), "supported MCP forms should submit explicitly");
  assert(form.includes(">Decline<"), "supported MCP forms should remain declineable");

  const permission = renderApproval({
    kind: "permissions",
    reason: "Needs network",
    permissions: { network: { domains: ["example.com"] } },
  });
  assert(permission.includes("Needs network"), "permission reason should render");
  assert(permission.includes("example.com"), "exact requested permission should render");
  assert(permission.includes("Allow once"), "permission approval should be turn-scoped in the UI");

  const unsupported = renderApproval({
    kind: "mcp_unsupported",
    server_name: "example",
    message: "Unsupported form",
    reason: "Nested objects are unsupported.",
  });
  assert(unsupported.includes("Nested objects are unsupported."), "unsupported reason should render");
  assert(unsupported.includes(">Decline<"), "unsupported MCP requests should be declineable");
  assert(!unsupported.includes(">Approve<") && !unsupported.includes(">Submit<"), "unsupported MCP requests should be decline-only");
} finally {
  await server.close();
}
