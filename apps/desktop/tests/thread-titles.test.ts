const { deriveThreadTitle, sanitizeAiThreadTitle, shouldReplaceThreadTitle } = await import("../src/lib/threadTitles.js");

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const messages = [{ role: "user", content: "fix the flaky release manifest verifier" }];

equal(deriveThreadTitle(messages), "fix the flaky release manifest verifier", "heuristic title should use the first user message");
equal(sanitizeAiThreadTitle('Title: "Release Manifest Fix."'), "Release Manifest Fix", "AI title should strip prefix, quotes, and punctuation");
equal(sanitizeAiThreadTitle("One"), null, "AI title should reject one-word output");
equal(sanitizeAiThreadTitle("one two three four five six"), null, "AI title should reject more than five words");
equal(sanitizeAiThreadTitle("Release manifest fix! now"), null, "AI title should reject punctuation inside the title");
equal(shouldReplaceThreadTitle("New chat", messages), true, "new chat title can be replaced");
equal(shouldReplaceThreadTitle("fix the flaky release manifest verifier", messages), true, "heuristic title can be replaced");
equal(shouldReplaceThreadTitle("Manual title", messages), false, "manual title should not be replaced");

export {};
