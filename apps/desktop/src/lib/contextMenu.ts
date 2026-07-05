export type ContextMenuPoint = { x: number; y: number };
export type ContextMenuSize = { width: number; height: number };

const DEFAULT_MARGIN = 8;

type ClosestElement = {
  closest: (selector: string) => unknown;
};

function hasClosest(value: unknown): value is ClosestElement {
  return Boolean(value && typeof (value as ClosestElement).closest === "function");
}

export function clampContextMenuPosition(
  point: ContextMenuPoint,
  menu: ContextMenuSize,
  viewport: ContextMenuSize,
  margin = DEFAULT_MARGIN,
): ContextMenuPoint {
  const maxX = Math.max(margin, viewport.width - menu.width - margin);
  const maxY = Math.max(margin, viewport.height - menu.height - margin);
  return {
    x: Math.min(Math.max(point.x, margin), maxX),
    y: Math.min(Math.max(point.y, margin), maxY),
  };
}

export function shouldPreserveNativeContextMenu(target: EventTarget | null): boolean {
  if (!hasClosest(target)) return false;
  if (target.closest("input, textarea, select, a[href], [contenteditable=''], [contenteditable='true']")) return true;

  const selection = typeof window === "undefined" ? null : window.getSelection?.();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.toString().trim()) return false;
  const range = selection.getRangeAt(0);
  try {
    return typeof range.intersectsNode === "function" && range.intersectsNode(target as unknown as Node);
  } catch {
    return false;
  }
}
