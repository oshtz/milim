import { clampContextMenuPosition, shouldPreserveNativeContextMenu } from "../src/lib/contextMenu.js";

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

const editableTarget = {
  closest: (selector: string) => selector.includes("textarea") ? {} : null,
} as unknown as EventTarget;

const linkTarget = {
  closest: (selector: string) => selector.includes("a[href]") ? {} : null,
} as unknown as EventTarget;

const plainTarget = {
  closest: () => null,
} as unknown as EventTarget;

equal(shouldPreserveNativeContextMenu(editableTarget), true, "editable targets should keep native context menu");
equal(shouldPreserveNativeContextMenu(linkTarget), true, "links should keep native context menu");
equal(shouldPreserveNativeContextMenu(plainTarget), false, "plain app targets should use app context menu");

const clamped = clampContextMenuPosition({ x: 790, y: 590 }, { width: 220, height: 180 }, { width: 800, height: 600 });
equal(clamped.x, 572, "menu x should clamp inside viewport");
equal(clamped.y, 412, "menu y should clamp inside viewport");

const margined = clampContextMenuPosition({ x: -20, y: -30 }, { width: 100, height: 100 }, { width: 800, height: 600 });
equal(margined.x, 8, "menu x should respect margin");
equal(margined.y, 8, "menu y should respect margin");

export {};
