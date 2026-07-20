import { play, setEnabled, type SoundName } from "cuelume";

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
