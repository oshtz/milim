export type CommitMessageModelInfo = {
  id: string;
  owned_by?: string;
};

function isAccountRuntimeId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return normalized.startsWith("codex:") || normalized.startsWith("claude:");
}

export function commitMessageModelCandidates(models: readonly CommitMessageModelInfo[], preferred: string): string[] {
  const providerModels = models
    .filter((model) => {
      const owner = model.owned_by?.trim().toLowerCase() ?? "";
      return model.id.trim() && !isAccountRuntimeId(model.id) && owner !== "codex" && owner !== "claude code";
    })
    .map((model) => model.id.trim());

  const preferredModel = preferred.trim();
  const ordered = preferredModel && providerModels.includes(preferredModel)
    ? [preferredModel, ...providerModels.filter((model) => model !== preferredModel)]
    : providerModels;
  return Array.from(new Set(ordered));
}
