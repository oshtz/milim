import type { ChatAttachment, ChatMessage } from "../api.js";
import {
  assertValidImageAttachment,
  OMITTED_IMAGE_NOTE,
  selectOutboundImageAttachments,
} from "./attachmentInput.js";

// ponytail: local copy keeps pure wire tests from importing browser/Tauri API code.
const MAX_ATTACHMENT_BYTES = 128 * 1024;

type WireTextPart = { type: "text"; text: string };
type WireImagePart = {
  type: "image_url";
  image_url: { url: string; detail?: string };
};
export type WireMessageContent = string | Array<WireTextPart | WireImagePart>;
export interface WireChatMessage {
  role: string;
  content: WireMessageContent;
}

export function attachmentsToPromptContext(
  attachments?: ChatAttachment[],
  imageNote = "[Image attachment is available in Milim, but this text-only view cannot receive image pixels.]",
): string {
  if (!attachments?.length) return "";
  const blocks = attachments.map((attachment) => {
    const meta = [
      `name=${attachment.name}`,
      `mime=${attachment.mime || "application/octet-stream"}`,
      `size=${attachment.size}`,
      attachment.truncated ? `truncated_at=${MAX_ATTACHMENT_BYTES}` : null,
      attachment.sourcePath ? `path=${attachment.sourcePath}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const content = attachment.content?.trimEnd();
    const imageText = attachment.dataUrl ? imageNote : "";
    return [
      `--- attachment ${meta} ---`,
      [content, imageText].filter(Boolean).join("\n") ||
        "[No text content available for this attachment.]",
      "--- end attachment ---",
    ].join("\n");
  });
  return ["[Attached files]", ...blocks, "[/Attached files]"].join("\n");
}

export function wireMessageContent(
  message: ChatMessage,
  imageNote?: string,
): string {
  if (message.approval) return "";
  const attachmentContext = attachmentsToPromptContext(
    message.attachments,
    imageNote,
  );
  if (!attachmentContext) return message.content;
  return message.content
    ? `${message.content}\n\n${attachmentContext}`
    : attachmentContext;
}

function imageAttachments(attachments?: ChatAttachment[]): ChatAttachment[] {
  return (attachments ?? []).filter((attachment) => {
    if (!attachment.mime.toLowerCase().startsWith("image/")) return false;
    assertValidImageAttachment(attachment);
    return true;
  });
}

function wireImageMessageText(message: ChatMessage): string {
  if (message.approval) return "";
  const textAttachments = (message.attachments ?? []).filter(
    (attachment) => !attachment.dataUrl || attachment.content?.trimEnd(),
  );
  const attachmentContext = attachmentsToPromptContext(
    textAttachments,
    "",
  );
  if (!attachmentContext) return message.content;
  return message.content
    ? `${message.content}\n\n${attachmentContext}`
    : attachmentContext;
}

export function wireMessages(messages: ChatMessage[]): WireChatMessage[] {
  const selectedImages = selectOutboundImageAttachments(messages);
  return messages
    .filter((m) => !m.approval)
    .map((m) => {
      const allImages = imageAttachments(m.attachments);
      const images = allImages.filter((image) => selectedImages.has(image));
      if (!images.length)
        return {
          role: m.role,
          content: wireMessageContent(
            m,
            allImages.length ? OMITTED_IMAGE_NOTE : undefined,
          ),
        };
      return {
        role: m.role,
        content: [
          { type: "text", text: wireImageMessageText(m) },
          ...images.map((attachment) => ({
            type: "image_url" as const,
            image_url: { url: attachment.dataUrl ?? "" },
          })),
        ],
      };
    });
}
