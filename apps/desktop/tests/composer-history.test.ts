import { canNavigateComposerHistory, moveComposerHistory } from "../src/lib/composerHistory.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const history = ["first", "second"];

const last = moveComposerHistory(history, "draft", null, "previous");
assert(last, "previous should recall newest history");
equal(last.index, 1, "newest history index");
equal(last.value, "second", "newest history value");

const older = moveComposerHistory(history, "draft", last.index, "previous");
assert(older, "previous should recall older history");
equal(older.index, 0, "older history index");
equal(older.value, "first", "older history value");

const newer = moveComposerHistory(history, "draft", older.index, "next");
assert(newer, "next should recall newer history");
equal(newer.index, 1, "newer history index");
equal(newer.value, "second", "newer history value");

const draft = moveComposerHistory(history, "draft", newer.index, "next");
assert(draft, "next from newest should restore draft");
equal(draft.index, null, "draft index");
equal(draft.value, "draft", "draft value");

equal(moveComposerHistory(history, "draft", null, "next"), null, "next from draft should not move");
assert(canNavigateComposerHistory("one\ntwo", 0, 0, "previous", null), "caret at start can recall previous");
assert(!canNavigateComposerHistory("one\ntwo", 4, 4, "previous", null), "middle line keeps arrow navigation");
assert(!canNavigateComposerHistory("one", 3, 3, "previous", null), "end of draft keeps arrow navigation");
assert(!canNavigateComposerHistory("one", 0, 0, "next", null), "down from draft keeps arrow navigation");
assert(canNavigateComposerHistory("second", 0, 0, "previous", 1), "history mode can move previous at start");
assert(!canNavigateComposerHistory("second", 3, 3, "previous", 1), "history mode keeps up-arrow navigation away from start");
assert(canNavigateComposerHistory("second", 6, 6, "next", 1), "history mode can move next at end");
assert(!canNavigateComposerHistory("second", 3, 3, "next", 1), "history mode keeps down-arrow navigation before end");
assert(!canNavigateComposerHistory("one", 0, 1, "previous", null), "selection keeps arrow navigation");
