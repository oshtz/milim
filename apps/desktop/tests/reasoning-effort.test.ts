import { deepEqual, equal } from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { ModelInfo } from "../src/api";

const { hasReasoningEffortChoices, reasoningEffortByModelWithSelection, reasoningEffortDisplay, reasoningEffortForModel, reasoningEffortOptions } = await import("../src/lib/reasoningEffort.js");

const optional: ModelInfo = {
  id: "openrouter/deepseek-r1",
  owned_by: "openrouter",
  reasoning: {
    supported_efforts: ["none", "low", "high"],
    default_effort: "medium",
    default_enabled: true,
    mandatory: false,
  },
};

const mandatory: ModelInfo = {
  id: "claude-sonnet-4",
  owned_by: "anthropic",
  reasoning: {
    supported_efforts: ["none", "low", "high"],
    default_effort: "high",
    default_enabled: true,
    mandatory: true,
  },
};
const autoOnly: ModelInfo = {
  id: "plain-model",
  owned_by: "provider",
  reasoning: { supported_efforts: [], default_effort: undefined, default_enabled: true, mandatory: false },
};
const ollamaThinking: ModelInfo = {
  id: "deepseek-r1",
  owned_by: "Ollama",
  reasoning: {
    supported_efforts: ["none", "low", "medium", "high", "max"],
    default_effort: "medium",
    default_enabled: true,
    mandatory: false,
  },
};
const lmStudioGptOss: ModelInfo = {
  id: "openai/gpt-oss-20b",
  owned_by: "LM Studio",
  reasoning: {
    supported_efforts: ["low", "medium", "high"],
    default_effort: "medium",
    default_enabled: true,
    mandatory: true,
  },
};
const lmStudioNative: ModelInfo = {
  id: "deepseek-r1",
  owned_by: "LM Studio",
  reasoning: {
    supported_efforts: ["none", "on"],
    default_effort: "on",
    default_enabled: true,
    mandatory: false,
  },
};

deepEqual(reasoningEffortOptions(optional), ["auto", "none", "low", "high"], "optional models should expose off");
deepEqual(reasoningEffortOptions(mandatory), ["auto", "low", "high"], "mandatory models should hide off");
deepEqual(reasoningEffortOptions(ollamaThinking), ["auto", "none", "low", "medium", "high", "max"], "Ollama thinking models should expose local effort choices");
deepEqual(reasoningEffortOptions(lmStudioGptOss), ["auto", "low", "medium", "high"], "LM Studio gpt-oss should expose Responses effort choices");
deepEqual(reasoningEffortOptions(lmStudioNative), ["auto", "none", "on"], "LM Studio native reasoning should expose advertised options");
equal(hasReasoningEffortChoices(autoOnly), false, "auto-only models should not show reasoning controls");
equal(reasoningEffortForModel({ [optional.id]: "high", [mandatory.id]: "low" }, optional.id, [optional, mandatory]), "high", "effort should be read per model");
equal(reasoningEffortForModel({ [mandatory.id]: "none" }, mandatory.id, [mandatory]), "auto", "unsupported selections should fall back to auto");
equal(reasoningEffortForModel({ [lmStudioGptOss.id]: "max" }, lmStudioGptOss.id, [lmStudioGptOss]), "auto", "LM Studio unsupported saved efforts should fall back to auto");
equal(reasoningEffortForModel({ [lmStudioNative.id]: "on" }, lmStudioNative.id, [lmStudioNative]), "on", "LM Studio native on should persist");
equal(reasoningEffortForModel({ [lmStudioNative.id]: "max" }, lmStudioNative.id, [lmStudioNative]), "auto", "LM Studio native unsupported saved efforts should fall back to auto");
equal(reasoningEffortForModel({ "unknown-model": "high" }, "unknown-model", [optional]), "auto", "unknown models should not send effort overrides");
deepEqual(
  reasoningEffortByModelWithSelection({ [optional.id]: "low" }, optional.id, "auto"),
  {},
  "choosing auto should remove the per-model override",
);
equal(reasoningEffortDisplay("medium", { id: "gemini-2.5-pro", owned_by: "Gemini" }).detail, "budget 4k", "Gemini 2.5 labels should show budget mapping");
equal(reasoningEffortDisplay("high", { id: "gemini-3-pro", owned_by: "Gemini" }).detail, "thinking HIGH", "Gemini 3 labels should show thinking level mapping");
equal(reasoningEffortDisplay("xhigh", mandatory).detail, "effort xhigh", "Claude labels should use effort terminology");
equal(reasoningEffortDisplay("on", lmStudioNative).detail, "reasoning on", "LM Studio native labels should use reasoning terminology");

const modelPicker = readFileSync("src/components/ModelPicker.tsx", "utf8");
equal(modelPicker.includes("mp-effort-btn"), true, "model picker should expose a compact effort trigger");
equal(modelPicker.includes("mp-effort-menu"), true, "model picker should expose effort choices in a custom row menu");
equal(modelPicker.includes("createPortal("), true, "model picker should render the effort menu outside the clipped model list");
equal(modelPicker.includes("setModelReasoningEffort"), true, "model picker selector should persist the global per-model effort");
equal(modelPicker.includes("hasReasoningEffortChoices(m)"), true, "model picker should hide auto-only reasoning controls");
equal(modelPicker.includes("cap !== \"reasoning\" || !hasEffortChoices"), true, "model picker should avoid duplicate reasoning icons");
equal(
  modelPicker.indexOf("className={\"mp-star\"") < modelPicker.indexOf("className=\"mp-pick\""),
  true,
  "model picker should render the favorite star before the model pick button",
);
const controlBar = readFileSync("src/components/ControlBar.tsx", "utf8");
equal(controlBar.includes("reasoning-effort-trigger"), false, "control bar should not render a separate reasoning chip");
equal(controlBar.includes('closest(".mp-effort-menu")'), true, "control bar outside-click handling should ignore the portaled effort menu");
