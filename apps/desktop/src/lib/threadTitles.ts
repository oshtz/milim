import type { ChatMessage } from "../api";

export const NEW_CHAT_TITLE = "New chat";
export const AI_THREAD_TITLE_SYSTEM_PROMPT =
  "You name chat threads. Reply with only a concise 2-5 word title. No quotes, punctuation, emojis, prefixes, or explanations.";

export function deriveThreadTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const t = (firstUser?.content ?? "").trim().replace(/\s+/g, " ");
  const attachmentTitle = firstUser?.attachments?.[0]?.name;
  if (!t && attachmentTitle) return `Attached: ${attachmentTitle}`;
  if (!t) return NEW_CHAT_TITLE;
  return t.length > 42 ? t.slice(0, 42) + "..." : t;
}

export function sanitizeAiThreadTitle(raw: string): string | null {
  const firstLine = raw
    .trim()
    .replace(/^```(?:\w+)?\s*/i, "")
    .replace(/```$/i, "")
    .split(/\r?\n/)
    .find((line) => line.trim());
  const title = (firstLine ?? "")
    .trim()
    .replace(/^(?:[-*]|\d+[.)]|\u2022)\s*/, "")
    .replace(/^(?:thread title|title)\s*:\s*/i, "")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/[.!?:;,]+$/g, "")
    .replace(/[\/&-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = title.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 5) return null;
  if (/[^\p{L}\p{N} ]/u.test(title)) return null;
  return title;
}

export function shouldReplaceThreadTitle(currentTitle: string, messages: ChatMessage[]): boolean {
  const title = currentTitle.trim();
  return title === NEW_CHAT_TITLE || title === deriveThreadTitle(messages);
}

export function isThreadNamingModel(model: string | { id: string; capabilities?: { imageOutput?: boolean; videoOutput?: boolean } }): boolean {
  const id = (typeof model === "string" ? model : model.id).trim().toLowerCase();
  if (!id || id === "mock-echo" || id.startsWith("codex:") || id.startsWith("claude:")) return false;
  return typeof model === "string" || (!model.capabilities?.imageOutput && !model.capabilities?.videoOutput);
}
