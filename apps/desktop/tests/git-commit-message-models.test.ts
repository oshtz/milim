import { commitMessageModelCandidates } from "../src/lib/gitCommitMessageModels.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const models = [
  { id: "codex:gpt-5.5", owned_by: "Codex" },
  { id: "claude:opus", owned_by: "Local Claude CLI" },
  { id: "gpt-4.1", owned_by: "OpenAI" },
  { id: "llama3.2", owned_by: "Ollama" },
];

assert(
  commitMessageModelCandidates(models, "codex:gpt-5.5").join(",") ===
    "gpt-4.1,llama3.2",
  "account runtime preferred model should fall back to provider models",
);

assert(
  commitMessageModelCandidates(models, "llama3.2")[0] === "llama3.2",
  "reachable preferred provider model should stay first",
);

assert(
  commitMessageModelCandidates([{ id: "codex:gpt-5.5", owned_by: "Codex" }], "")
    .length === 0,
  "account-runtime-only model list should not provide commit generation candidates",
);

export {};
