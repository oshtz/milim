class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true,
});

const {
  SETTINGS_SEARCH_ENTRIES,
  matchingSettingsEntries,
} = await import("../src/settings/search.js");

const {
  DEFAULT_MEDIA_SETTINGS,
  DEFAULT_VOICE_SETTINGS,
  STT_OPTIONS,
  VOICE_RECORDING_MAX_SECONDS,
  VOICE_RECORDING_MIN_SECONDS,
  VOICE_SERVER_VAD_THRESHOLD_MAX,
  VOICE_SERVER_VAD_THRESHOLD_MIN,
  VOICE_TTS_SPEED_MAX,
  VOICE_TTS_SPEED_MIN,
  VOICE_VAD_SILENCE_MAX_MS,
  VOICE_VAD_SILENCE_MIN_MS,
  useSettings,
} = await import("../src/settings/store.js");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function deepEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

equal(DEFAULT_VOICE_SETTINGS.enabled, false, "voice must be opt-in by default");
equal(DEFAULT_VOICE_SETTINGS.hotkeyEnabled, false, "global voice hotkey must be opt-in by default");
equal(DEFAULT_VOICE_SETTINGS.dictationInjectText, false, "active-app dictation must be opt-in by default");
equal(DEFAULT_VOICE_SETTINGS.hotkeyShortcut, "CommandOrControl+Shift+Space", "global voice hotkey should have a safe default");
equal(useSettings.getState().voice.enabled, false, "persisted voice state must start disabled");
equal(useSettings.getState().voice.hotkeyEnabled, false, "persisted global voice hotkey state must start disabled");
equal(useSettings.getState().voice.dictationInjectText, false, "persisted active-app dictation state must start disabled");
equal(useSettings.getState().voice.provider, "whisper", "whisper is the default local STT provider");
equal(DEFAULT_MEDIA_SETTINGS.providerId, "", "media provider should be unset by default");
equal(useSettings.getState().media.providerId, "", "persisted media provider should start unset");
deepEqual(useSettings.getState().reasoningEffortByModel, {}, "reasoning effort should default to no global model overrides");

const optionIds = STT_OPTIONS.map((option: { id: string }) => option.id);
assert(optionIds.includes("whisper"), "Whisper STT option should be shown");
assert(optionIds.includes("parakeet"), "Parakeet STT option should be shown");
assert(optionIds.includes("remote"), "remote/cloud STT option should be shown");
assert(
  SETTINGS_SEARCH_ENTRIES.some((entry: { id: string }) => entry.id === "audio-hotkey"),
  "settings search should include the voice hotkey row",
);
equal(
  matchingSettingsEntries("hotkey")[0]?.id,
  "audio-hotkey",
  "settings search should return individual hotkey setting",
);
equal(
  matchingSettingsEntries("kokoro").some((entry: { id: string }) => entry.id === "audio-tts-native"),
  true,
  "settings search should match provider-specific TTS settings",
);

useSettings.getState().setVoiceSettings({
  enabled: true,
  hotkeyEnabled: true,
  dictationInjectText: true,
  hotkeyShortcut: "Alt+Shift+Space",
  provider: "parakeet",
  whisperModelPath: "C:/models/ggml-base.en.bin",
  openAiApiKey: "stt-secret",
  ttsOpenAiApiKey: "tts-secret",
});

equal(useSettings.getState().voice.enabled, true, "voice toggle should persist on");
equal(useSettings.getState().voice.hotkeyEnabled, true, "global hotkey toggle should persist on");
equal(useSettings.getState().voice.dictationInjectText, true, "active-app dictation toggle should persist on");
equal(useSettings.getState().voice.hotkeyShortcut, "Alt+Shift+Space", "global hotkey shortcut should persist");
equal(useSettings.getState().voice.provider, "parakeet", "provider selection should persist");
equal(useSettings.getState().voice.whisperModelPath, "C:/models/ggml-base.en.bin", "model path should persist");
equal(useSettings.getState().voice.openAiApiKey, "stt-secret", "STT API key should remain available in memory");
equal(useSettings.getState().voice.ttsOpenAiApiKey, "tts-secret", "TTS API key should remain available in memory");
assert(localStorage.getItem("milim.settings")?.includes("parakeet"), "voice settings should be written to canonical localStorage");
assert(!localStorage.getItem("milim.settings")?.includes("stt-secret"), "STT API key should not be written to synced settings");
assert(!localStorage.getItem("milim.settings")?.includes("tts-secret"), "TTS API key should not be written to synced settings");
assert(localStorage.getItem("milim.local.voiceSecrets")?.includes("stt-secret"), "STT API key should be stored in machine-local settings");
assert(localStorage.getItem("milim.local.voiceSecrets")?.includes("tts-secret"), "TTS API key should be stored in machine-local settings");

useSettings.getState().setVoiceSettings({
  vadSilenceMs: 100,
  maxRecordingSeconds: 0,
  serverVadThreshold: 0,
  ttsSpeed: 0.1,
});
equal(useSettings.getState().voice.vadSilenceMs, VOICE_VAD_SILENCE_MIN_MS, "silence window should clamp to UI min");
equal(useSettings.getState().voice.maxRecordingSeconds, VOICE_RECORDING_MIN_SECONDS, "max recording should clamp to UI min");
equal(useSettings.getState().voice.serverVadThreshold, VOICE_SERVER_VAD_THRESHOLD_MIN, "VAD threshold should clamp to UI min");
equal(useSettings.getState().voice.ttsSpeed, VOICE_TTS_SPEED_MIN, "TTS speed should clamp to UI min");
useSettings.getState().setVoiceSettings({
  vadSilenceMs: 99999,
  maxRecordingSeconds: 99999,
  serverVadThreshold: 99999,
  ttsSpeed: 99999,
});
equal(useSettings.getState().voice.vadSilenceMs, VOICE_VAD_SILENCE_MAX_MS, "silence window should clamp to UI max");
equal(useSettings.getState().voice.maxRecordingSeconds, VOICE_RECORDING_MAX_SECONDS, "max recording should clamp to UI max");
equal(useSettings.getState().voice.serverVadThreshold, VOICE_SERVER_VAD_THRESHOLD_MAX, "VAD threshold should clamp to UI max");
equal(useSettings.getState().voice.ttsSpeed, VOICE_TTS_SPEED_MAX, "TTS speed should clamp to UI max");

useSettings.getState().setMediaSettings({
  providerId: "prov-openrouter",
  modelByProvider: {
    "prov-openrouter": "google/gemini-2.5-flash-image",
  },
  parametersByProviderModel: {
    "prov-openrouter::google/gemini-2.5-flash-image": {
      aspect_ratio: "16:9",
      seed: 42,
    },
  },
  advancedByProviderModel: {
    "prov-openrouter::google/gemini-2.5-flash-image": "{\n  \"image_config\": {}\n}",
  },
  favoriteModelIdsByProvider: {
    "prov-openrouter": ["google/gemini-2.5-flash-image"],
  },
  modelSearchByProvider: {
    "prov-openrouter": "gemini image",
  },
});

equal(useSettings.getState().media.providerId, "prov-openrouter", "media provider selection should persist");
equal(
  useSettings.getState().media.modelByProvider["prov-openrouter"],
  "google/gemini-2.5-flash-image",
  "media model selection should persist per provider",
);
equal(
  useSettings.getState().media.parametersByProviderModel["prov-openrouter::google/gemini-2.5-flash-image"].aspect_ratio,
  "16:9",
  "media model parameter choices should persist",
);
assert(localStorage.getItem("milim.settings")?.includes("google/gemini-2.5-flash-image"), "media settings should be written to synced settings");
equal(
  useSettings.getState().media.favoriteModelIdsByProvider["prov-openrouter"][0],
  "google/gemini-2.5-flash-image",
  "media model favorites should persist per provider",
);
equal(
  useSettings.getState().media.modelSearchByProvider["prov-openrouter"],
  "gemini image",
  "media model search text should persist per provider",
);
assert(!localStorage.getItem("milim.settings")?.includes("openrouter-secret"), "media settings must not store provider API keys");

useSettings.getState().setModelReasoningEffort("openrouter/deepseek-r1", "high");
deepEqual(
  useSettings.getState().reasoningEffortByModel,
  { "openrouter/deepseek-r1": "high" },
  "reasoning effort should persist globally per model",
);
assert(localStorage.getItem("milim.settings")?.includes("openrouter/deepseek-r1"), "global model reasoning effort should persist in settings");
useSettings.getState().setModelReasoningEffort("openrouter/deepseek-r1", "auto");
deepEqual(useSettings.getState().reasoningEffortByModel, {}, "auto should remove the global model reasoning override");

export {};
