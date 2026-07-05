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

function isLiveInternalPart(part: ChatStreamPart): boolean {
  return part.kind === "thinking" || (part.kind === "event" && part.eventType === "tool" && (part.status ?? "done") !== "error");
}

export function groupCompletedStreamActivity(parts: ChatStreamPart[], streaming: boolean): ChatStreamDisplayPart[] {
  const next: ChatStreamDisplayPart[] = [];
  let group: ChatStreamPart[] = [];
  const isInternalPart = streaming ? isLiveInternalPart : isCompletedInternalPart;

  const flush = () => {
    if (group.length === 1) next.push(group[0]);
    else if (group.length > 1) {
      const toolParts = group.filter(isCompletedToolEvent);
      next.push(streaming || toolParts.length !== group.length ? { kind: "workGroup", parts: group } : { kind: "toolGroup", parts: toolParts });
    }
    group = [];
  };

  for (const part of parts) {
    if (isInternalPart(part)) {
      group.push(part);
    } else {
      flush();
      next.push(part);
    }
  }
  flush();
  return next;
}
