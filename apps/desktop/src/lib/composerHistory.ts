export type ComposerHistoryDirection = "previous" | "next";
export type ComposerHistoryIndex = number | null;

export function canNavigateComposerHistory(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  direction: ComposerHistoryDirection,
  currentIndex: ComposerHistoryIndex,
): boolean {
  if (selectionStart !== selectionEnd) return false;
  if (direction === "previous") return selectionStart === 0;
  return currentIndex !== null && selectionEnd === value.length;
}

export function moveComposerHistory(
  history: readonly string[],
  draft: string,
  currentIndex: ComposerHistoryIndex,
  direction: ComposerHistoryDirection,
): { index: ComposerHistoryIndex; value: string } | null {
  if (!history.length || (direction === "next" && currentIndex === null)) return null;
  let index: ComposerHistoryIndex;
  if (direction === "previous") {
    index = currentIndex === null ? history.length - 1 : Math.max(0, currentIndex - 1);
  } else {
    if (currentIndex === null) return null;
    index = currentIndex === history.length - 1 ? null : currentIndex + 1;
  }
  return { index, value: index === null ? draft : history[index] };
}
