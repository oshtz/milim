import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ReasoningEffort } from "../api";
import { userStateStorage } from "../persistence/userStateStorage.js";
import { reasoningEffortByModelWithSelection } from "../lib/reasoningEffort.js";

export interface MediaSettings {
  providerId: string;
  modelByProvider: Record<string, string>;
  parametersByProviderModel: Record<string, Record<string, unknown>>;
  advancedByProviderModel: Record<string, string>;
  favoriteModelIdsByProvider: Record<string, string[]>;
  modelSearchByProvider: Record<string, string>;
}

export const DEFAULT_MEDIA_SETTINGS: MediaSettings = {
  providerId: "",
  modelByProvider: {},
  parametersByProviderModel: {},
  advancedByProviderModel: {},
  favoriteModelIdsByProvider: {},
  modelSearchByProvider: {},
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

interface SettingsState {
  favorites: string[];
  favoritesOnly: boolean;
  reasoningEffortByModel: Record<string, ReasoningEffort>;
  media: MediaSettings;
  toggleFavorite: (id: string) => void;
  setFavoritesOnly: (v: boolean) => void;
  setModelReasoningEffort: (model: string, effort: ReasoningEffort) => void;
  setMediaSettings: (settings: Partial<MediaSettings>) => void;
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return value === "auto" || value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "on" || value === "xhigh" || value === "max";
}

function normalizeReasoningEffortByModel(value: unknown): Record<string, ReasoningEffort> {
  const record = asRecord(value);
  if (!record) return {};
  const result: Record<string, ReasoningEffort> = {};
  for (const [model, effort] of Object.entries(record)) {
    if (!model.trim() || !isReasoningEffort(effort) || effort === "auto") continue;
    result[model] = effort;
  }
  return result;
}

function normalizeParameterRecord(value: unknown): Record<string, Record<string, unknown>> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record)
      .map(([key, parameters]) => [key, asRecord(parameters) ?? {}] as const),
  );
}

function normalizeStringArrayRecord(value: unknown): Record<string, string[]> {
  const record = asRecord(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).map(([key, items]) => [
      key,
      Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [],
    ]),
  );
}

function normalizeMediaSettings(settings?: Partial<MediaSettings>): MediaSettings {
  return {
    providerId: typeof settings?.providerId === "string" ? settings.providerId : "",
    modelByProvider: normalizeStringRecord(settings?.modelByProvider),
    parametersByProviderModel: normalizeParameterRecord(settings?.parametersByProviderModel),
    advancedByProviderModel: normalizeStringRecord(settings?.advancedByProviderModel),
    favoriteModelIdsByProvider: normalizeStringArrayRecord(settings?.favoriteModelIdsByProvider),
    modelSearchByProvider: normalizeStringRecord(settings?.modelSearchByProvider),
  };
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      favorites: [],
      favoritesOnly: false,
      reasoningEffortByModel: {},
      media: DEFAULT_MEDIA_SETTINGS,
      toggleFavorite: (id) =>
        set((s) => ({
          favorites: s.favorites.includes(id)
            ? s.favorites.filter((x) => x !== id)
            : [...s.favorites, id],
        })),
      setFavoritesOnly: (favoritesOnly) => set({ favoritesOnly }),
      setModelReasoningEffort: (model, effort) =>
        set((s) => ({
          reasoningEffortByModel: reasoningEffortByModelWithSelection(s.reasoningEffortByModel, model, effort),
        })),
      setMediaSettings: (settings) =>
        set((s) => ({
          media: normalizeMediaSettings({ ...s.media, ...settings }),
        })),
    }),
    {
      name: "milim.settings",
      storage: createJSONStorage(() => userStateStorage),
      merge: (persisted, current) => {
        const saved = { ...((persisted ?? {}) as Partial<SettingsState> & { voice?: unknown }) };
        delete saved.voice;
        return {
          ...current,
          ...saved,
          favoritesOnly: Boolean(saved?.favoritesOnly),
          reasoningEffortByModel: normalizeReasoningEffortByModel(saved?.reasoningEffortByModel),
          media: normalizeMediaSettings(saved?.media),
        };
      },
      partialize: (s) => ({
        favorites: s.favorites,
        favoritesOnly: s.favoritesOnly,
        reasoningEffortByModel: s.reasoningEffortByModel,
        media: s.media,
      }),
    },
  ),
);
