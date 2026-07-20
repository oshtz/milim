import { play, setEnabled, type SoundName } from "cuelume";
import type { ChatMessage } from "../api";

const DISABLED_SELECTOR = ":disabled, [aria-disabled='true']";
const SILENT_SELECTOR = ".win-btn, .ui-slider";
const SOUND_TARGETS: ReadonlyArray<readonly [string, SoundName]> = [
  ["[data-interface-sound='droplet'], .send-btn.stop, .sheet-close, [aria-label^='Close ']", "droplet"],
  ["[role='switch'], [role='checkbox'], [role='radio'], [role='tab']", "toggle"],
  ["[role='menuitem'], .ui-select-item", "tick"],
  [".send-btn, .btn-accent", "press"],
];

setEnabled(false);

export function interfaceSoundForTarget(target: Pick<Element, "closest">): SoundName | null {
  if (target.closest(SILENT_SELECTOR)) return null;
  for (const [selector, sound] of SOUND_TARGETS) {
    const matched = target.closest(selector);
    if (!matched) continue;
    return matched.matches(DISABLED_SELECTOR) ? null : sound;
  }
  return null;
}

export function pendingAttentionKey(
  messages: ChatMessage[],
  proposedWorkerRunId?: string,
): string | null {
  if (proposedWorkerRunId) return `worker:${proposedWorkerRunId}`;
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    const messageKey = message.id ?? String(messageIndex);
    if (message.approval?.status === "pending") {
      return `message:${messageKey}:${message.approval.kind}`;
    }
    const pendingStep = message.run?.steps.find((step) => step.approval?.status === "pending");
    if (pendingStep?.approval) return `tool:${messageKey}:${pendingStep.approval.id}`;
    const pendingPart = message.streamParts?.find(
      (part) => part.kind === "event" && part.approvalStatus === "pending",
    );
    if (pendingPart?.kind === "event") {
      return `tool:${messageKey}:${pendingPart.approvalId ?? pendingPart.callId ?? pendingPart.label}`;
    }
  }
  return null;
}

export function installInterfaceSoundClicks(root: Document = document): () => void {
  const onClick = (event: MouseEvent) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const sound = interfaceSoundForTarget(event.target);
    if (sound) play(sound);
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}

export function setInterfaceSoundsEnabled(enabled: boolean): void {
  setEnabled(enabled);
}

export function playInterfaceSound(sound: SoundName): void {
  play(sound);
}
