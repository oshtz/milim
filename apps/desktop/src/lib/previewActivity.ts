import type { ChatStreamPart, ChatStreamEventStatus, ChatStreamPreviewPoint } from "../api.js";

export type PreviewControlGesture = "move" | "click" | "scroll" | "type" | "inspect";

export type PreviewControlActivity = {
  id: string;
  gesture: PreviewControlGesture;
  label: string;
  detail?: string;
  status: ChatStreamEventStatus;
  point?: ChatStreamPreviewPoint;
};

const TOOL_GESTURES: Record<string, PreviewControlGesture> = {
  mouse_move: "move",
  mouse_click: "click",
  scroll: "scroll",
  type_text: "type",
  key_press: "type",
  screenshot: "inspect",
  preview_dom_snapshot: "inspect",
  preview_click: "click",
  preview_scroll: "scroll",
  preview_type_text: "type",
  preview_key_press: "type",
};

export function previewControlActivityFromDebugUrl(href: string): PreviewControlActivity | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!isLocalPreviewDebugUrl(url)) return null;
  const gesture = url.searchParams.get("previewActivity");
  if (!isPreviewControlGesture(gesture)) return null;
  const label = url.searchParams.get("previewActivityLabel")?.trim() || "Preview activity";
  const detail = url.searchParams.get("previewActivityDetail")?.trim() || undefined;
  const point = previewPointFromDebugUrl(url);
  return {
    id: `debug:${gesture}:${label}:${detail ?? ""}`,
    gesture,
    label,
    detail,
    status: "running",
    point,
  };
}

export function previewControlActivityFromStreamParts(parts: readonly ChatStreamPart[] | undefined): PreviewControlActivity | null {
  if (!parts?.length) return null;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const part = parts[i];
    if (part.kind !== "event" || part.eventType !== "tool") continue;
    const gesture = previewGestureForToolEvent(part);
    if (!gesture || part.status === "error") continue;
    return {
      id: `${part.callId ?? part.name ?? part.label}:${part.status ?? "done"}:${part.detail ?? ""}:${i}`,
      gesture,
      label: part.label,
      detail: part.detail,
      status: part.status ?? "done",
      point: part.previewPoint,
    };
  }
  return null;
}

function previewPointFromDebugUrl(url: URL): ChatStreamPreviewPoint | undefined {
  const x = numberParam(url, "previewActivityX");
  const y = numberParam(url, "previewActivityY");
  if (x == null || y == null) return undefined;
  const requestedUnit = url.searchParams.get("previewActivityPointUnit");
  const unit = requestedUnit === "pixel" || requestedUnit === "percent"
    ? requestedUnit
    : x >= 0 && x <= 1 && y >= 0 && y <= 1
      ? "ratio"
      : "percent";
  return { x, y, unit };
}

function numberParam(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw == null || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function isPreviewControlGesture(value: string | null): value is PreviewControlGesture {
  return value === "move" || value === "click" || value === "scroll" || value === "type" || value === "inspect";
}

function isLocalPreviewDebugUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "[::1]";
}

function previewGestureForToolEvent(part: Extract<ChatStreamPart, { kind: "event" }>): PreviewControlGesture | null {
  const text = [part.name, part.label, part.detail].filter(Boolean).join(" ").toLowerCase();
  for (const [name, gesture] of Object.entries(TOOL_GESTURES)) {
    if (text.includes(name)) return gesture;
  }
  return null;
}
