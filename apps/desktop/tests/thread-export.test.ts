import { deepEqual, equal, match } from "node:assert/strict";
import type { Session } from "../src/sessions/store.js";
import {
  chatExportFilename,
  exportedSessionCandidate,
  markdownSessionCandidate,
  sessionExportPayload,
  sessionMarkdownExport,
} from "../src/lib/threadExport.js";

const session = {
  id: "thread-1",
  title: "Bad:/ Thread",
  createdAt: 1,
  updatedAt: 2,
  messages: [
    { role: "user", content: "Hello" },
    {
      role: "assistant",
      content: "",
      streamParts: [
        { kind: "thinking", content: "hidden" },
        { kind: "text", content: "Visible " },
        { kind: "text", content: "answer" },
      ],
    },
  ],
} as Session;

equal(chatExportFilename(session.title), "Bad- Thread.milim-chat.json");
equal(chatExportFilename(session.title, "markdown"), "Bad- Thread.md");

const payload = sessionExportPayload(session, "2026-07-03T00:00:00.000Z");
equal(payload.exportedAt, "2026-07-03T00:00:00.000Z");
equal(exportedSessionCandidate(payload)?.title, session.title);

const markdown = sessionMarkdownExport(session, "2026-07-03T00:00:00.000Z");
match(markdown, /<!-- milim-thread:v1 -->/);
match(markdown, /# Bad:\/ Thread/);
match(markdown, /Visible answer/);

deepEqual(markdownSessionCandidate(markdown), {
  title: "Bad:/ Thread",
  messages: [
    { role: "user", content: "Hello" },
    { role: "assistant", content: "Visible answer" },
  ],
});

equal(markdownSessionCandidate("# Plain markdown"), null);
