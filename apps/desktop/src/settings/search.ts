export type SettingsSectionId = "app" | "chat" | "audio" | "appearance" | "history" | "mobile" | "system" | "about" | "developer";
export type AudioTab = "input" | "output";

export type SettingSearchEntry = {
  id: string;
  label: string;
  section: SettingsSectionId;
  tab?: AudioTab;
  aliases?: string[];
};

export const SETTINGS_SEARCH_ENTRIES: SettingSearchEntry[] = [
  { id: "app-mode", label: "Mode", section: "app", aliases: ["simple", "workbench", "interface"] },
  { id: "app-window-layout", label: "Window and layout", section: "app", aliases: ["always on top", "sidebar", "ui size", "zoom", "new chat"] },
  { id: "chat-composer", label: "Composer", section: "chat", aliases: ["send shortcut", "enter", "density"] },
  { id: "chat-threads", label: "Threads", section: "chat", aliases: ["auto title", "ai names", "naming model"] },
  { id: "audio-input-master", label: "Voice input", section: "audio", tab: "input", aliases: ["stt", "speech to text", "transcription", "microphone"] },
  { id: "audio-output-master", label: "Speech output", section: "audio", tab: "output", aliases: ["tts", "text to speech", "speaker"] },
  { id: "audio-input-provider", label: "Input provider", section: "audio", tab: "input", aliases: ["whisper", "openai", "remote", "parakeet"] },
  { id: "audio-whisper-model", label: "Whisper model path", section: "audio", tab: "input", aliases: ["model", "ggml"] },
  { id: "audio-stt-openai", label: "OpenAI-compatible STT", section: "audio", tab: "input", aliases: ["api key", "endpoint", "model"] },
  { id: "audio-stt-remote", label: "Remote STT endpoint", section: "audio", tab: "input", aliases: ["endpoint"] },
  { id: "audio-stt-parakeet", label: "Parakeet command", section: "audio", tab: "input", aliases: ["command", "model"] },
  { id: "audio-recording", label: "Recording", section: "audio", tab: "input", aliases: ["silence", "max recording", "vad"] },
  { id: "audio-hotkey", label: "Global push-to-talk", section: "audio", tab: "input", aliases: ["hotkey", "shortcut", "dictation"] },
  { id: "audio-preflight", label: "Server speech preflight", section: "audio", tab: "input", aliases: ["vad", "threshold", "silero", "native"] },
  { id: "audio-output-provider", label: "Output provider", section: "audio", tab: "output", aliases: ["tts", "piper", "kokoro", "openai", "command"] },
  { id: "audio-tts-openai", label: "OpenAI-compatible TTS", section: "audio", tab: "output", aliases: ["api key", "endpoint", "voice", "speed"] },
  { id: "audio-tts-piper", label: "Piper setup", section: "audio", tab: "output", aliases: ["preset", "install", "model", "command"] },
  { id: "audio-tts-native", label: "Native TTS setup", section: "audio", tab: "output", aliases: ["kokoro", "onnx", "model", "config"] },
  { id: "audio-tts-voice-speed", label: "Voice and speed", section: "audio", tab: "output", aliases: ["alloy", "rate"] },
  { id: "appearance-theme", label: "Theme", section: "appearance", aliases: ["custom", "edit", "delete", "palette"] },
  { id: "appearance-chat-surface", label: "Chat surface", section: "appearance", aliases: ["layout", "message width", "avatars"] },
  { id: "appearance-code-blocks", label: "Code blocks", section: "appearance", aliases: ["theme", "syntax"] },
  { id: "appearance-background", label: "Background image", section: "appearance", aliases: ["fit", "treatment"] },
  { id: "history-retention", label: "Archive retention", section: "history", aliases: ["delete", "purge", "7 days", "14 days", "30 days"] },
  { id: "history-projects", label: "Archived projects", section: "history", aliases: ["restore", "delete"] },
  { id: "history-chats", label: "Archived chats", section: "history", aliases: ["threads", "restore", "delete"] },
  { id: "mobile-companion", label: "Mobile companion", section: "mobile", aliases: ["phone", "pairing", "qr", "tailscale", "relay"] },
  { id: "system-shortcuts", label: "Keyboard shortcuts", section: "system", aliases: ["hotkey", "command", "reset"] },
  { id: "about-version", label: "Version", section: "about", aliases: ["current", "latest"] },
  { id: "about-updates", label: "Updates", section: "about", aliases: ["github release", "download", "restart"] },
  { id: "developer-mode", label: "Developer mode", section: "developer", aliases: ["debug", "experimental", "onboarding"] },
];

export function matchingSettingsEntries(query: string): SettingSearchEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [];
  return SETTINGS_SEARCH_ENTRIES.filter((entry) =>
    [entry.label, entry.section, ...(entry.aliases ?? [])]
      .join(" ")
      .toLowerCase()
      .includes(normalized),
  );
}
