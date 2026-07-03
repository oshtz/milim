import type { ChatStreamPart } from "../api";

type ChatStreamEventPart = Extract<ChatStreamPart, { kind: "event" }>;

export type ChatStreamToolGroup = {
  kind: "toolGroup";
  parts: ChatStreamEventPart[];
};

export type ChatStreamWorkGroup = {
  kind: "workGroup";
  parts: ChatStreamPart[];
};

export type ChatStreamDisplayPart = ChatStreamPart | ChatStreamToolGroup | ChatStreamWorkGroup;

function isCompletedToolEvent(part: ChatStreamPart): part is ChatStreamEventPart {
  return part.kind === "event" && part.eventType === "tool" && (part.status ?? "done") === "done";
}

function isCompletedInternalPart(part: ChatStreamPart): boolean {
  return part.kind === "thinking" || isCompletedToolEvent(part);
}

export function groupCompletedStreamActivity(parts: ChatStreamPart[], streaming: boolean): ChatStreamDisplayPart[] {
  if (streaming) return parts;
  const next: ChatStreamDisplayPart[] = [];
  let group: ChatStreamPart[] = [];

  const flush = () => {
    if (group.length === 1) next.push(group[0]);
    else if (group.length > 1) {
      const toolParts = group.filter(isCompletedToolEvent);
      next.push(toolParts.length === group.length ? { kind: "toolGroup", parts: toolParts } : { kind: "workGroup", parts: group });
    }
    group = [];
  };

  for (const part of parts) {
    if (isCompletedInternalPart(part)) {
      group.push(part);
    } else {
      flush();
      next.push(part);
    }
  }
  flush();
  return next;
}
