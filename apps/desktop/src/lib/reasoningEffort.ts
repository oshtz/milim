import type { ModelInfo, ReasoningEffort } from "../api";

export const REASONING_EFFORT_LABEL: Record<ReasoningEffort, string> = {
  auto: "Auto",
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-high",
  max: "Max",
};

const GEMINI_25_BUDGET_LABEL: Partial<Record<ReasoningEffort, string>> = {
  none: "budget 0",
  minimal: "budget 128",
  low: "budget 1k",
  medium: "budget 4k",
  high: "budget 8k",
  xhigh: "budget 16k",
  max: "budget 16k",
};

export function reasoningEffortDisplay(effort: ReasoningEffort, model?: Pick<ModelInfo, "id" | "owned_by">): { label: string; detail: string } {
  const id = model?.id.toLowerCase() ?? "";
  const owner = model?.owned_by.toLowerCase() ?? "";
  if (effort === "auto") return { label: "Auto", detail: "provider default" };
  if (id.includes("gemini-3") || (owner.includes("gemini") && id.includes("3"))) {
    return { label: REASONING_EFFORT_LABEL[effort], detail: `thinking ${effort.toUpperCase()}` };
  }
  if (id.includes("gemini-2.5") || (owner.includes("gemini") && id.includes("2.5"))) {
    return { label: REASONING_EFFORT_LABEL[effort], detail: GEMINI_25_BUDGET_LABEL[effort] ?? "thinking budget" };
  }
  if (owner.includes("anthropic") || id.includes("claude")) {
    return { label: REASONING_EFFORT_LABEL[effort], detail: `effort ${effort}` };
  }
  if (owner.includes("openrouter")) {
    return { label: REASONING_EFFORT_LABEL[effort], detail: `reasoning ${effort}` };
  }
  return { label: REASONING_EFFORT_LABEL[effort], detail: `effort ${effort}` };
}

export function reasoningEffortOptions(model?: Pick<ModelInfo, "reasoning">): ReasoningEffort[] {
  const reasoning = model?.reasoning;
  const supported = reasoning?.supported_efforts ?? [];
  const options: ReasoningEffort[] = ["auto", ...supported];
  return Array.from(new Set(options)).filter((effort) => effort !== "none" || !reasoning?.mandatory);
}

export function hasReasoningEffortChoices(model?: Pick<ModelInfo, "reasoning">): boolean {
  return reasoningEffortOptions(model).some((effort) => effort !== "auto");
}

export function normalizeReasoningEffortForModel(effort: ReasoningEffort, model?: Pick<ModelInfo, "reasoning">): ReasoningEffort {
  return reasoningEffortOptions(model).includes(effort) ? effort : "auto";
}

export function reasoningEffortForModel(reasoningEffortByModel: Record<string, ReasoningEffort> | undefined, model: string, models: ModelInfo[]): ReasoningEffort {
  const selected = models.find((item) => item.id === model);
  return normalizeReasoningEffortForModel(reasoningEffortByModel?.[model] ?? "auto", selected);
}

export function reasoningEffortByModelWithSelection(
  current: Record<string, ReasoningEffort>,
  model: string,
  effort: ReasoningEffort,
): Record<string, ReasoningEffort> {
  const next = { ...current };
  if (!model.trim() || effort === "auto") {
    delete next[model];
  } else {
    next[model] = effort;
  }
  return next;
}
