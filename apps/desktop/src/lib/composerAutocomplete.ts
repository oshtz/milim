export type ComposerAutocompleteTrigger = {
  prefix: "/" | "@";
  query: string;
  start: number;
  end: number;
};

export function composerAutocompleteTriggerAt(value: string, cursor: number): ComposerAutocompleteTrigger | null {
  const end = Math.max(0, Math.min(cursor, value.length));
  let start = end;
  while (start > 0 && !/\s/.test(value[start - 1])) start -= 1;
  const token = value.slice(start, end);
  const prefix = token[0];
  if (prefix !== "/" && prefix !== "@") return null;
  return { prefix, query: token.slice(1).toLowerCase(), start, end };
}

export function replaceComposerAutocompleteTrigger(
  value: string,
  trigger: ComposerAutocompleteTrigger,
  replacement: string,
): string {
  return value.slice(0, trigger.start) + replacement + value.slice(trigger.end);
}

export function skillTagCompletion(prefix: "/" | "@", skillName: string): string {
  return `${prefix}${skillName} `;
}

export function mcpToolTagCompletion(toolName: string): string {
  return `/${toolName} `;
}
