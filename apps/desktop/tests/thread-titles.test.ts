const { deriveThreadTitle, isThreadNamingModel, sanitizeAiThreadTitle, shouldReplaceThreadTitle } = await import("../src/lib/threadTitles.js");

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const messages = [{ role: "user", content: "fix the flaky release manifest verifier" }];

equal(deriveThreadTitle(messages), "fix the flaky release manifest verifier", "heuristic title should use the first user message");
equal(sanitizeAiThreadTitle('Title: "Release Manifest Fix."'), "Release Manifest Fix", "AI title should strip prefix, quotes, and punctuation");
equal(sanitizeAiThreadTitle("- Title: `Release-manifest fix.`"), "Release manifest fix", "AI title should strip list markers and separator punctuation");
equal(sanitizeAiThreadTitle("Search & replace / QA"), "Search replace QA", "AI title should treat separators as spaces");
equal(sanitizeAiThreadTitle("One"), null, "AI title should reject one-word output");
equal(sanitizeAiThreadTitle("one two three four five six"), null, "AI title should reject more than five words");
equal(sanitizeAiThreadTitle("Release manifest fix! now"), null, "AI title should reject punctuation inside the title");
equal(shouldReplaceThreadTitle("New chat", messages), true, "new chat title can be replaced");
equal(shouldReplaceThreadTitle("fix the flaky release manifest verifier", messages), true, "heuristic title can be replaced");
equal(shouldReplaceThreadTitle("Manual title", messages), false, "manual title should not be replaced");
equal(isThreadNamingModel("openrouter/gemma"), true, "provider chat model should be eligible for AI naming");
equal(isThreadNamingModel("codex:gpt-5.5"), false, "Codex runtime should not be used for AI naming");
equal(isThreadNamingModel("claude:sonnet"), false, "Claude runtime should not be used for AI naming");
equal(isThreadNamingModel({ id: "openrouter/flux", capabilities: { imageOutput: true } }), false, "image output model should not be used for AI naming");
equal(isThreadNamingModel({ id: "openrouter/lyria", capabilities: { musicOutput: true } }), false, "music output model should not be used for AI naming");

export {};
