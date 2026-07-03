import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ReasoningEffort } from "../api";
import { userStateStorage } from "../persistence/userStateStorage.js";
import { reasoningEffortByModelWithSelection } from "../lib/reasoningEffort.js";

export type VoiceSttProvider = "whisper" | "openai" | "remote" | "parakeet";
export type TtsProvider = "command" | "openai" | "piper" | "native";
export type NativeTtsEngine = "piper" | "kokoro";
export type ServerVadProvider = "energy" | "native";

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

export interface SttOption {
  id: VoiceSttProvider;
  label: string;
  badge: string;
  detail: string;
}

export const STT_OPTIONS: SttOption[] = [
  {
    id: "whisper",
    label: "Whisper",
    badge: "Local",
    detail: "Runs on-device with a ggml Whisper model. Best privacy, larger models.",
  },
  {
    id: "parakeet",
    label: "Parakeet",
    badge: "Command",
    detail: "Run a local NVIDIA Parakeet / NeMo-compatible command without bundling a Python runtime.",
  },
  {
    id: "openai",
    label: "OpenAI-compatible STT",
    badge: "Remote",
    detail: "Multipart /audio/transcriptions endpoint with model and optional API key.",
  },
  {
    id: "remote",
    label: "Raw endpoint",
    badge: "Remote",
    detail: "POST raw WAV to a milim-compatible endpoint that returns JSON with text.",
  },
];

export interface TtsOption {
  id: TtsProvider;
  label: string;
  badge: string;
  detail: string;
}

export interface PiperPreset {
  id: string;
  name: string;
  language: string;
  size: string;
  modelUrl: string;
  configUrl: string;
}

export interface KokoroPreset {
  id: string;
  name: string;
  voice: string;
  language: string;
  size: string;
  modelUrl: string;
  configUrl: string;
  voiceUrl: string;
}

export interface VadPreset {
  id: string;
  name: string;
  language: string;
  size: string;
  modelUrl: string;
}

export const TTS_OPTIONS: TtsOption[] = [
  {
    id: "command",
    label: "Command",
    badge: "Wrapper",
    detail: "Run any local TTS wrapper that returns WAV bytes on stdout.",
  },
  {
    id: "openai",
    label: "OpenAI-compatible TTS",
    badge: "Remote",
    detail: "Call a compatible /audio/speech endpoint for hosted or local HTTP TTS.",
  },
  {
    id: "piper",
    label: "Piper",
    badge: "Local",
    detail: "Run a local Piper executable with an ONNX voice model.",
  },
  {
    id: "native",
    label: "Native ORT",
    badge: "Local",
    detail: "Prepare in-process Piper ONNX or Kokoro models for the native runtime.",
  },
];

export const PIPER_PRESETS: PiperPreset[] = [
  {
    id: "en_US-lessac-medium",
    name: "en_US-lessac-medium",
    language: "English US",
    size: "~60 MB",
    modelUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx",
    configUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json",
  },
  {
    id: "en_GB-alba-medium",
    name: "en_GB-alba-medium",
    language: "English UK",
    size: "~60 MB",
    modelUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx",
    configUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alba/medium/en_GB-alba-medium.onnx.json",
  },
  {
    id: "en_US-amy-low",
    name: "en_US-amy-low",
    language: "English US",
    size: "~30 MB",
    modelUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/low/en_US-amy-low.onnx",
    configUrl: "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/low/en_US-amy-low.onnx.json",
  },
];

export const KOKORO_PRESETS: KokoroPreset[] = [
  {
    id: "kokoro-q8f16-af_alloy",
    name: "Kokoro q8f16 af_alloy",
    voice: "af_alloy",
    language: "English US",
    size: "~86 MB model + voice",
    modelUrl: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_q8f16.onnx",
    configUrl: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/config.json",
    voiceUrl: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_alloy.bin",
  },
  {
    id: "kokoro-q8f16-af_heart",
    name: "Kokoro q8f16 af_heart",
    voice: "af_heart",
    language: "English US",
    size: "~86 MB model + voice",
    modelUrl: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_q8f16.onnx",
    configUrl: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/config.json",
    voiceUrl: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin",
  },
  {
    id: "kokoro-q8f16-am_echo",
    name: "Kokoro q8f16 am_echo",
    voice: "am_echo",
    language: "English US",
    size: "~86 MB model + voice",
    modelUrl: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_q8f16.onnx",
    configUrl: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/config.json",
    voiceUrl: "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/am_echo.bin",
  },
];

export const VAD_PRESETS: VadPreset[] = [
  {
    id: "silero-vad",
    name: "Silero VAD",
    language: "Multilingual",
    size: "~2.2 MB",
    modelUrl: "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx",
  },
];

export interface VoiceSettings {
  enabled: boolean;
  provider: VoiceSttProvider;
  whisperModelPath: string;
  openAiEndpoint: string;
  openAiApiKey: string;
  openAiModel: string;
  remoteEndpoint: string;
  parakeetCommand: string;
  parakeetModel: string;
  vadEnabled: boolean;
  vadSilenceMs: number;
  maxRecordingSeconds: number;
  hotkeyEnabled: boolean;
  hotkeyShortcut: string;
  dictationInjectText: boolean;
  serverVadEnabled: boolean;
  serverVadProvider: ServerVadProvider;
  serverVadModelPath: string;
  serverVadThreshold: number;
  ttsEnabled: boolean;
  ttsProvider: TtsProvider;
  ttsCommand: string;
  ttsOpenAiEndpoint: string;
  ttsOpenAiApiKey: string;
  ttsOpenAiModel: string;
  piperCommand: string;
  piperModelPath: string;
  nativeTtsEngine: NativeTtsEngine;
  nativeTtsModelPath: string;
  nativeTtsConfigPath: string;
  ttsVoice: string;
  ttsSpeed: number;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  provider: "whisper",
  whisperModelPath: "",
  openAiEndpoint: "https://api.openai.com/v1/audio/transcriptions",
  openAiApiKey: "",
  openAiModel: "gpt-4o-mini-transcribe",
  remoteEndpoint: "",
  parakeetCommand: "",
  parakeetModel: "nvidia/parakeet-tdt-0.6b-v2",
  vadEnabled: true,
  vadSilenceMs: 1200,
  maxRecordingSeconds: 60,
  hotkeyEnabled: false,
  hotkeyShortcut: "CommandOrControl+Shift+Space",
  dictationInjectText: false,
  serverVadEnabled: false,
  serverVadProvider: "energy",
  serverVadModelPath: "",
  serverVadThreshold: 0.015,
  ttsEnabled: false,
  ttsProvider: "command",
  ttsCommand: "",
  ttsOpenAiEndpoint: "https://api.openai.com/v1/audio/speech",
  ttsOpenAiApiKey: "",
  ttsOpenAiModel: "gpt-4o-mini-tts",
  piperCommand: "",
  piperModelPath: "",
  nativeTtsEngine: "piper",
  nativeTtsModelPath: "",
  nativeTtsConfigPath: "",
  ttsVoice: "alloy",
  ttsSpeed: 1,
};

const LOCAL_VOICE_SECRETS_KEY = "milim.local.voiceSecrets";

type VoiceSecrets = Pick<VoiceSettings, "openAiApiKey" | "ttsOpenAiApiKey">;

function emptyVoiceSecrets(): VoiceSecrets {
  return { openAiApiKey: "", ttsOpenAiApiKey: "" };
}

function getMachineLocalStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function voiceSecretsFromRecord(value: Record<string, unknown> | null): VoiceSecrets {
  return {
    openAiApiKey: typeof value?.openAiApiKey === "string" ? value.openAiApiKey : "",
    ttsOpenAiApiKey: typeof value?.ttsOpenAiApiKey === "string" ? value.ttsOpenAiApiKey : "",
  };
}

function parseVoiceSecrets(raw: string | null): VoiceSecrets {
  if (!raw) return emptyVoiceSecrets();
  try {
    return voiceSecretsFromRecord(asRecord(JSON.parse(raw)));
  } catch {
    return emptyVoiceSecrets();
  }
}

function readStoredVoiceSecrets(storage: Storage): VoiceSecrets {
  return parseVoiceSecrets(storage.getItem(LOCAL_VOICE_SECRETS_KEY));
}

function loadMachineVoiceSecrets(): VoiceSecrets {
  const storage = getMachineLocalStorage();
  if (!storage) return emptyVoiceSecrets();
  return readStoredVoiceSecrets(storage);
}

function persistMachineVoiceSecrets(settings: Partial<VoiceSettings>): void {
  const storage = getMachineLocalStorage();
  if (!storage) return;
  const next = readStoredVoiceSecrets(storage);
  if ("openAiApiKey" in settings) next.openAiApiKey = settings.openAiApiKey ?? "";
  if ("ttsOpenAiApiKey" in settings) next.ttsOpenAiApiKey = settings.ttsOpenAiApiKey ?? "";
  storage.setItem(LOCAL_VOICE_SECRETS_KEY, JSON.stringify(next));
}

function withoutVoiceSecrets(voice: VoiceSettings): VoiceSettings {
  return { ...voice, openAiApiKey: "", ttsOpenAiApiKey: "" };
}

function isHttpEndpoint(value: string): boolean {
  const endpoint = value.trim();
  return endpoint.startsWith("http://") || endpoint.startsWith("https://");
}

export function voiceProviderConfigIssue(voice: VoiceSettings): string | null {
  if (voice.provider === "whisper") {
    return voice.whisperModelPath.trim()
      ? null
      : "Whisper model path is required.";
  }
  if (voice.provider === "openai") {
    if (!voice.openAiEndpoint.trim()) return "OpenAI-compatible STT endpoint is required.";
    if (!isHttpEndpoint(voice.openAiEndpoint)) return "OpenAI-compatible STT endpoint must start with http:// or https://.";
    return voice.openAiModel.trim()
      ? null
      : "OpenAI-compatible STT model is required.";
  }
  if (voice.provider === "remote") {
    if (!voice.remoteEndpoint.trim()) return "Remote STT endpoint is required.";
    return isHttpEndpoint(voice.remoteEndpoint)
      ? null
      : "Remote STT endpoint must start with http:// or https://.";
  }
  if (voice.provider === "parakeet") {
    return voice.parakeetCommand.trim()
      ? null
      : "Parakeet command is required.";
  }
  return "Unknown voice provider.";
}

export function voiceTtsConfigIssue(voice: VoiceSettings): string | null {
  if (!voice.ttsEnabled) return null;
  if (voice.ttsProvider === "command" && !voice.ttsCommand.trim()) return "TTS command is required.";
  if (voice.ttsProvider === "openai") {
    if (!voice.ttsOpenAiEndpoint.trim()) return "OpenAI-compatible TTS endpoint is required.";
    if (!isHttpEndpoint(voice.ttsOpenAiEndpoint)) return "OpenAI-compatible TTS endpoint must start with http:// or https://.";
    if (!voice.ttsOpenAiModel.trim()) return "OpenAI-compatible TTS model is required.";
  }
  if (voice.ttsProvider === "piper") {
    if (!voice.piperCommand.trim()) return "Piper command is required.";
    if (!voice.piperModelPath.trim()) return "Piper model path is required.";
  }
  if (voice.ttsProvider === "native" && !voice.nativeTtsModelPath.trim()) {
    return "Native TTS model path is required.";
  }
  if (!Number.isFinite(voice.ttsSpeed) || voice.ttsSpeed <= 0) {
    return "TTS speed must be greater than 0.";
  }
  return null;
}

export function voiceVadConfigIssue(voice: VoiceSettings): string | null {
  if (!voice.serverVadEnabled) return null;
  if (voice.serverVadProvider === "native" && !voice.serverVadModelPath.trim()) {
    return "Native VAD model path is required.";
  }
  if (
    voice.serverVadProvider === "energy" &&
    (!Number.isFinite(voice.serverVadThreshold) || voice.serverVadThreshold <= 0)
  ) {
    return "VAD threshold must be greater than 0.";
  }
  return null;
}

interface SettingsState {
  favorites: string[];
  favoritesOnly: boolean;
  reasoningEffortByModel: Record<string, ReasoningEffort>;
  voice: VoiceSettings;
  media: MediaSettings;
  toggleFavorite: (id: string) => void;
  setFavoritesOnly: (v: boolean) => void;
  setModelReasoningEffort: (model: string, effort: ReasoningEffort) => void;
  setVoiceSettings: (settings: Partial<VoiceSettings>) => void;
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
  return value === "auto" || value === "none" || value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
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

function normalizeVoiceSettings(settings?: Partial<VoiceSettings>): VoiceSettings {
  const requestedProvider = settings?.provider;
  const provider = requestedProvider && STT_OPTIONS.some((option) => option.id === requestedProvider)
    ? requestedProvider
    : DEFAULT_VOICE_SETTINGS.provider;
  const requestedTtsProvider = settings?.ttsProvider;
  const ttsProvider = requestedTtsProvider && TTS_OPTIONS.some((option) => option.id === requestedTtsProvider)
    ? requestedTtsProvider
    : DEFAULT_VOICE_SETTINGS.ttsProvider;
  const merged = {
    ...DEFAULT_VOICE_SETTINGS,
    ...settings,
    provider,
    ttsProvider,
  };
  const serverVadProvider =
    merged.serverVadProvider === "native" || merged.serverVadProvider === "energy"
      ? merged.serverVadProvider
      : DEFAULT_VOICE_SETTINGS.serverVadProvider;
  const nativeTtsEngine =
    merged.nativeTtsEngine === "kokoro" || merged.nativeTtsEngine === "piper"
      ? merged.nativeTtsEngine
      : DEFAULT_VOICE_SETTINGS.nativeTtsEngine;
  return {
    ...merged,
    serverVadProvider,
    nativeTtsEngine,
    vadSilenceMs: Number.isFinite(merged.vadSilenceMs)
      ? Math.max(300, Math.round(merged.vadSilenceMs))
      : DEFAULT_VOICE_SETTINGS.vadSilenceMs,
    maxRecordingSeconds: Number.isFinite(merged.maxRecordingSeconds)
      ? Math.max(1, Math.round(merged.maxRecordingSeconds))
      : DEFAULT_VOICE_SETTINGS.maxRecordingSeconds,
    hotkeyShortcut: merged.hotkeyShortcut.trim() || DEFAULT_VOICE_SETTINGS.hotkeyShortcut,
    serverVadThreshold: Number.isFinite(merged.serverVadThreshold)
      ? Math.max(0.001, Number(merged.serverVadThreshold))
      : DEFAULT_VOICE_SETTINGS.serverVadThreshold,
    ttsSpeed: Number.isFinite(merged.ttsSpeed)
      ? Math.max(0.1, Number(merged.ttsSpeed))
      : DEFAULT_VOICE_SETTINGS.ttsSpeed,
  };
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      favorites: [],
      favoritesOnly: false,
      reasoningEffortByModel: {},
      voice: normalizeVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, ...loadMachineVoiceSecrets() }),
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
      setVoiceSettings: (settings) => {
        persistMachineVoiceSecrets(settings);
        set((s) => ({
          voice: normalizeVoiceSettings({ ...s.voice, ...settings }),
        }));
      },
      setMediaSettings: (settings) =>
        set((s) => ({
          media: normalizeMediaSettings({ ...s.media, ...settings }),
        })),
    }),
    {
      name: "milim.settings",
      storage: createJSONStorage(() => userStateStorage),
      merge: (persisted, current) => {
        const saved = persisted as Partial<SettingsState> | undefined;
        return {
          ...current,
          ...saved,
          reasoningEffortByModel: normalizeReasoningEffortByModel(saved?.reasoningEffortByModel),
          voice: normalizeVoiceSettings({ ...withoutVoiceSecrets(normalizeVoiceSettings(saved?.voice)), ...loadMachineVoiceSecrets() }),
          media: normalizeMediaSettings(saved?.media),
        };
      },
      partialize: (s) => ({
        favorites: s.favorites,
        favoritesOnly: s.favoritesOnly,
        reasoningEffortByModel: s.reasoningEffortByModel,
        voice: withoutVoiceSecrets(s.voice),
        media: s.media,
      }),
    },
  ),
);
