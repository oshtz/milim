import type { ModelInfo, ProviderInfo } from "../api";

const PROVIDER_MODEL_PREFIX = "provider:";

export function providerModelId(providerId: string, modelId: string): string {
  return `${PROVIDER_MODEL_PREFIX}${providerId}:${modelId}`;
}

export function parseProviderModelId(
  model: string,
): { providerId: string; modelId: string } | null {
  const value = model.trim();
  if (!value.startsWith(PROVIDER_MODEL_PREFIX)) return null;
  const rest = value.slice(PROVIDER_MODEL_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0) return null;
  const providerId = rest.slice(0, separator);
  const modelId = rest.slice(separator + 1);
  return providerId && modelId ? { providerId, modelId } : null;
}

export function rawModelId(model: string): string {
  return parseProviderModelId(model)?.modelId ?? model;
}

export function modelDisplayName(model: Pick<ModelInfo, "id" | "display_id">): string {
  return model.display_id || model.id;
}

export function modelPickerKey(model: Pick<ModelInfo, "id" | "owned_by" | "provider_id">): string {
  return `${model.provider_id || model.owned_by}\0${model.id}`;
}

export function qualifyDuplicateProviderModels(models: ModelInfo[]): ModelInfo[] {
  const counts = new Map<string, number>();
  for (const model of models) {
    if (model.provider_id) counts.set(model.id, (counts.get(model.id) ?? 0) + 1);
  }
  return models.map((model) =>
    model.provider_id && (counts.get(model.id) ?? 0) > 1
      ? { ...model, id: providerModelId(model.provider_id, model.id), display_id: model.id }
      : model,
  );
}

export function providerOwnsModel(provider: ProviderInfo, model: string): boolean {
  const routed = parseProviderModelId(model);
  if (routed) {
    return provider.enabled && provider.id === routed.providerId && provider.models.includes(routed.modelId);
  }
  return provider.enabled && provider.models.includes(model);
}

export function mergeModelListsForPicker(
  chatModels: ModelInfo[],
  mediaModels: ModelInfo[],
): ModelInfo[] {
  const byKey = new Map<string, ModelInfo>();
  for (const model of chatModels) byKey.set(modelPickerKey(model), model);
  for (const model of mediaModels) {
    const key = modelPickerKey(model);
    const existing = byKey.get(key);
    byKey.set(
      key,
      existing
        ? {
            ...existing,
            owned_by: existing.owned_by || model.owned_by,
            capabilities: {
              ...existing.capabilities,
              ...model.capabilities,
            },
          }
        : model,
    );
  }
  return Array.from(byKey.values());
}

export function modelPickerGroups(
  models: ModelInfo[],
  favorites: string[],
  favoritesOnly: boolean,
  query: string,
): Array<[string, ModelInfo[]]> {
  const normalizedQuery = query.trim().toLowerCase();
  let list = models;
  if (normalizedQuery) {
    list = list.filter((model) =>
      modelDisplayName(model).toLowerCase().includes(normalizedQuery),
    );
  }
  if (favoritesOnly) list = list.filter((model) => favorites.includes(model.id));
  const favs = list.filter((model) => favorites.includes(model.id));
  const rest = list.filter((model) => !favorites.includes(model.id));
  const providerOrder = new Map<string, number>();
  const byProvider = new Map<string, ModelInfo[]>();
  for (const model of rest) {
    if (!providerOrder.has(model.owned_by)) providerOrder.set(model.owned_by, providerOrder.size);
    const group = byProvider.get(model.owned_by) ?? [];
    group.push(model);
    byProvider.set(model.owned_by, group);
  }
  const groups = Array.from(byProvider);
  groups.sort(
    ([left, leftModels], [right, rightModels]) =>
      leftModels.length - rightModels.length ||
      (providerOrder.get(left) ?? 0) - (providerOrder.get(right) ?? 0),
  );
  return favs.length ? [["Favorites", favs], ...groups] : groups;
}
