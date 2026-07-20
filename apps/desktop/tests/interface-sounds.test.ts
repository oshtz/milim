const { interfaceSoundForTarget, pendingAttentionKey } = await import("../src/ui/sounds.js");
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
equal(pendingAttentionKey([], "worker-1"), "worker:worker-1", "proposed worker plans should request attention");
equal(pendingAttentionKey([{
  id: "message-1",
  role: "assistant",
  content: "",
  approval: { kind: "tool", scope: "reply", status: "pending", requestedAt: 1 },
}]), "message:message-1:tool", "pending message approvals should request attention");
equal(pendingAttentionKey([{
  id: "message-2",
  role: "assistant",
  content: "",
  streamParts: [{ kind: "event", eventType: "tool", label: "Approve", approvalId: "approval-2", approvalStatus: "pending" }],
}]), "tool:message-2:approval-2", "pending streamed tool approvals should request attention");
equal(pendingAttentionKey([{ role: "assistant", content: "done" }]), null, "ordinary messages should not request attention");
equal(matchingSettingsEntries("sound")[0]?.id, "appearance-interface-sounds", "sound search should find the setting");
equal(matchingSettingsEntries("audio")[0]?.id, "appearance-interface-sounds", "audio search should find the setting");
equal(matchingSettingsEntries("attention")[0]?.id, "appearance-interface-sounds", "attention search should find the setting");

export {};
