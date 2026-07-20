const { interfaceSoundForTarget } = await import("../src/ui/sounds.js");
const { matchingSettingsEntries } = await import("../src/settings/search.js");

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function target(matches: string[], disabled = false): Parameters<typeof interfaceSoundForTarget>[0] {
  const element = {
    matches: (selector: string) => disabled && selector.includes(":disabled"),
  } as Element;
  return {
    closest: (selector: string) => matches.some((match) => selector.includes(match)) ? element : null,
  } as Parameters<typeof interfaceSoundForTarget>[0];
}

equal(interfaceSoundForTarget(target([".send-btn.stop", ".send-btn"])), "droplet", "stop should beat primary action sound");
equal(interfaceSoundForTarget(target(["[role='switch']"])), "toggle", "switches should use toggle");
equal(interfaceSoundForTarget(target(["[role='tab']"])), "toggle", "tabs should use toggle");
equal(interfaceSoundForTarget(target([".ui-select-item"])), "tick", "select options should use tick");
equal(interfaceSoundForTarget(target([".btn-accent"])), "press", "primary actions should use press");
equal(interfaceSoundForTarget(target([".btn-accent"], true)), null, "disabled controls should stay silent");
equal(interfaceSoundForTarget(target([".win-btn", ".btn-accent"])), null, "window controls should stay silent");
equal(interfaceSoundForTarget(target([".btn-ghost"])), null, "routine buttons should stay silent");
equal(matchingSettingsEntries("sound")[0]?.id, "appearance-interface-sounds", "sound search should find the setting");
equal(matchingSettingsEntries("audio")[0]?.id, "appearance-interface-sounds", "audio search should find the setting");

export {};
