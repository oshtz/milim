export type SettingsSectionId = "app" | "chat" | "appearance" | "history" | "mobile" | "system" | "about" | "developer";

export type SettingSearchEntry = {
  id: string;
  label: string;
  section: SettingsSectionId;
  aliases?: string[];
};

export const SETTINGS_SEARCH_ENTRIES: SettingSearchEntry[] = [
  { id: "app-window-layout", label: "Window and layout", section: "app", aliases: ["always on top", "sidebar", "ui size", "zoom", "new chat"] },
  { id: "chat-composer", label: "Composer", section: "chat", aliases: ["send shortcut", "enter", "density"] },
  { id: "chat-threads", label: "Threads", section: "chat", aliases: ["auto title", "ai names", "naming model"] },
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
