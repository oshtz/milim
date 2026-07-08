import { strict as assert } from "node:assert";
import {
  wireMessageContent,
  wireMessages,
} from "../src/lib/attachmentWire.js";
import type { ChatMessage } from "../src/api.js";

const message: ChatMessage = {
  role: "user",
  content: "Read these.",
  attachments: [
    {
      id: "text",
      name: "note.txt",
      mime: "text/plain",
      size: 5,
      content: "hello",
    },
    {
      id: "image",
      name: "screen.png",
      mime: "image/png",
      size: 4,
      dataUrl: "data:image/png;base64,AAAA",
    },
  ],
};

const textOnly = wireMessageContent(message);
assert.match(textOnly, /Read these\./);
assert.match(textOnly, /hello/);
assert.match(textOnly, /No OCR text was extracted/);

const wired = wireMessages([message]);
assert.equal(wired.length, 1);
assert.equal(wired[0].role, "user");

const content = wired[0].content;
assert(Array.isArray(content));
const parts = content;
assert.equal(parts.length, 2);
assert.equal(parts[0].type, "text");
assert.match(parts[0].text, /Read these\./);
assert.match(parts[0].text, /hello/);
assert.match(parts[0].text, /screen\.png/);
assert.doesNotMatch(parts[0].text, /No OCR text was extracted/);
assert.equal(parts[1].type, "image_url");
assert.equal(parts[1].image_url.url, "data:image/png;base64,AAAA");

const textAttachmentOnly = wireMessages([
  {
    role: "user",
    content: "Read this note.",
    attachments: [
      {
        id: "text",
        name: "note.txt",
        mime: "text/plain",
        size: 5,
        content: "hello",
      },
    ],
  },
]);
assert.equal(typeof textAttachmentOnly[0].content, "string");
assert.match(textAttachmentOnly[0].content as string, /Read this note\./);
assert.match(textAttachmentOnly[0].content as string, /hello/);
