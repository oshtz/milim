import {
  chatSearchSnippet,
  searchChatSessions,
  tokenizeChatSearchQuery,
  type SearchableChatSession,
} from "../src/lib/chatSearch.js";

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function ok(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}

const now = Date.UTC(2026, 5, 29);

function session(patch: Partial<SearchableChatSession> & Pick<SearchableChatSession, "id">): SearchableChatSession {
  return {
    title: "Untitled",
    updatedAt: now - 10 * 24 * 60 * 60 * 1000,
    messages: [],
    ...patch,
  };
}

equal(tokenizeChatSearchQuery("a b budget").join(","), "budget", "one-character terms should be ignored in multi-term queries");
equal(tokenizeChatSearchQuery("x").join(","), "x", "one-character full queries should be allowed");

{
  const results = searchChatSessions([
    session({ id: "body", title: "Meeting notes", messages: [{ role: "user", content: "Budget appears several times in body budget budget." }] }),
    session({ id: "title", title: "Budget plan", messages: [{ role: "assistant", content: "No direct body hit." }] }),
  ], [], "budget", 20, now);

  equal(results[0]?.sessionId, "title", "title matches should rank ahead of body-only matches");
}

{
  const results = searchChatSessions([
    session({ id: "one-token", title: "Roadmap", messages: [{ content: "The roadmap is ready." }] }),
    session({ id: "multi-token", title: "Planning", messages: [{ content: "The budget roadmap depends on a wider rollout." }] }),
  ], [], "budget roadmap", 20, now);

  equal(results[0]?.sessionId, "multi-token", "multi-token body matches should rank");
}

{
  const results = searchChatSessions([
    session({ id: "old", title: "Deploy notes", updatedAt: now - 20 * 24 * 60 * 60 * 1000 }),
    session({ id: "new", title: "Deploy notes", updatedAt: now - 60 * 1000 }),
  ], [], "deploy", 20, now);

  equal(results[0]?.sessionId, "new", "recent chats should win score ties");
}

{
  const results = searchChatSessions([
    session({ id: "old", updatedAt: now - 3 * 24 * 60 * 60 * 1000 }),
    session({ id: "new", updatedAt: now - 1000 }),
  ], [], "", 20, now);

  equal(results.map((result) => result.sessionId).join(","), "new,old", "empty query should return recent chats");
}

{
  const results = searchChatSessions([
    session({ id: "user-hit", messages: [{ role: "user", content: "deploy checklist" }] }),
    session({ id: "assistant-hit", messages: [{ role: "assistant", content: "deploy checklist" }] }),
  ], [], "from:assistant deploy", 20, now);

  equal(results.map((result) => result.sessionId).join(","), "assistant-hit", "from:assistant should restrict message matches");
}

{
  const results = searchChatSessions([
    session({ id: "active", messages: [{ content: "archived search" }] }),
    session({ id: "archived", archivedAt: now - 1000, messages: [{ content: "archived search" }] }),
  ], [], "is:archived archived", 20, now);

  equal(results.map((result) => result.sessionId).join(","), "archived", "is:archived should search archived threads only");
  equal(
    searchChatSessions([
      session({ id: "active", messages: [{ content: "shared search" }] }),
      session({ id: "archived", archivedAt: now - 1000, messages: [{ content: "shared search" }] }),
    ], [], "in:all shared", 20, now).length,
    2,
    "in:all should include active and archived threads",
  );
}

{
  const snippet = chatSearchSnippet("First line. The unusual launch phrase is buried near the middle of this message.", ["launch"], "launch");
  ok(snippet.includes("launch phrase"), "snippet should include the matching text");
}

export {};
