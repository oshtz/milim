import { filterCommandPaletteItems } from "../src/lib/commandPalette.js";

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const items = [
  { id: "chat.new", label: "New chat", keywords: ["thread"] },
  { id: "settings.open", label: "Open settings", keywords: ["preferences"] },
  { id: "generation.stop", label: "Stop generation", keywords: ["cancel"], available: false },
];

equal(
  filterCommandPaletteItems(items, "").map((item) => item.id).join(","),
  "chat.new,settings.open",
  "empty query should preserve available command order",
);
equal(
  filterCommandPaletteItems(items, "thread")[0]?.id,
  "chat.new",
  "keywords should match",
);
equal(
  filterCommandPaletteItems(items, "open pref")[0]?.id,
  "settings.open",
  "all query terms should match label and keywords",
);
equal(
  filterCommandPaletteItems(items, "cancel").length,
  0,
  "unavailable commands should stay hidden",
);

export {};
