import { composerAutocompleteTriggerAt, replaceComposerAutocompleteTrigger } from "../src/lib/composerAutocomplete.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function equal<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const midSlash = "Please use /mo";
const slash = composerAutocompleteTriggerAt(midSlash, midSlash.length);
assert(slash, "slash trigger should be detected away from the first character");
equal(slash.prefix, "/", "slash trigger prefix");
equal(slash.query, "mo", "slash trigger query");
equal(replaceComposerAutocompleteTrigger(midSlash, slash, "/model "), "Please use /model ", "slash replacement");

const midMention = "Check @src/App";
const mention = composerAutocompleteTriggerAt(midMention, midMention.length);
assert(mention, "mention trigger should be detected away from the first character");
equal(mention.prefix, "@", "mention trigger prefix");
equal(mention.query, "src/app", "mention query is lowercase");
equal(replaceComposerAutocompleteTrigger(midMention, mention, "@src/App.tsx "), "Check @src/App.tsx ", "mention replacement");

equal(composerAutocompleteTriggerAt("email ada@example.com", "email ada@example.com".length), null, "email should not trigger mention");
equal(composerAutocompleteTriggerAt("run/path", "run/path".length), null, "slash inside a token should not trigger commands");
