import type { SkillInfo, ToolInfo, WorkspaceFileSuggestion } from "../api";

export type ComposerTokenKind = "skill" | "mcp" | "file" | "link";

export type ComposerToken = {
  kind: ComposerTokenKind;
  start: number;
  end: number;
  label: string;
  value: string;
};

export type ComposerTokenPart =
  | { kind: "text"; text: string }
  | { kind: "token"; text: string; token: ComposerToken };

type ComposerTokenCandidate = ComposerToken & { priority: number };

type ComposerTokenOptions = {
  skills?: SkillInfo[];
  tools?: ToolInfo[];
  workspaceFiles?: WorkspaceFileSuggestion[];
};

const TOKEN_PRIORITIES: Record<ComposerTokenKind, number> = {
  skill: 0,
  mcp: 1,
  file: 2,
  link: 3,
};

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;

export function composerTokensForText(text: string, options: ComposerTokenOptions = {}): ComposerToken[] {
  const candidates = [
    ...skillTokenCandidates(text, options.skills ?? []),
    ...mcpTokenCandidates(text, options.tools ?? []),
    ...fileTokenCandidates(text, options.workspaceFiles ?? []),
    ...linkTokenCandidates(text),
  ];
  return selectTokenCandidates(candidates);
}

export function composerTokenParts(text: string, tokens: ComposerToken[]): ComposerTokenPart[] {
  const parts: ComposerTokenPart[] = [];
  let cursor = 0;
  for (const token of tokens) {
    if (token.start > cursor) {
      parts.push({ kind: "text", text: text.slice(cursor, token.start) });
    }
    parts.push({ kind: "token", text: text.slice(token.start, token.end), token });
    cursor = token.end;
  }
  if (cursor < text.length) {
    parts.push({ kind: "text", text: text.slice(cursor) });
  }
  return parts;
}

function skillTokenCandidates(text: string, skills: SkillInfo[]): ComposerTokenCandidate[] {
  const enabledSkills = skills
    .filter((skill) => skill.enabled && skill.name.trim())
    .slice()
    .sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));
  const candidates: ComposerTokenCandidate[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const prefix = text[index];
    if ((prefix !== "@" && prefix !== "/") || !isTagStartBoundary(text, index)) continue;
    for (const skill of enabledSkills) {
      const end = matchNameAt(text, index + 1, skill.name);
      if (end === null || !isTagEndBoundary(text, end)) continue;
      candidates.push({
        kind: "skill",
        start: index,
        end,
        label: skill.name,
        value: skill.id,
        priority: TOKEN_PRIORITIES.skill,
      });
      break;
    }
  }
  return candidates;
}

function mcpTokenCandidates(text: string, tools: ToolInfo[]): ComposerTokenCandidate[] {
  const toolsByName = tools
    .filter((tool) => tool.name.includes("__"))
    .slice()
    .sort((a, b) => b.name.length - a.name.length || a.name.localeCompare(b.name));
  const candidates: ComposerTokenCandidate[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "/" || !isTagStartBoundary(text, index)) continue;
    for (const tool of toolsByName) {
      const end = index + 1 + tool.name.length;
      if (text.slice(index + 1, end).toLowerCase() !== tool.name.toLowerCase()) continue;
      if (!isTagEndBoundary(text, end)) continue;
      candidates.push({
        kind: "mcp",
        start: index,
        end,
        label: tool.name,
        value: tool.name,
        priority: TOKEN_PRIORITIES.mcp,
      });
      break;
    }
  }
  return candidates;
}

function fileTokenCandidates(text: string, workspaceFiles: WorkspaceFileSuggestion[]): ComposerTokenCandidate[] {
  const knownPaths = new Set(workspaceFiles.map((file) => normalizePathToken(file.path)));
  const candidates: ComposerTokenCandidate[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "@" || !isTagStartBoundary(text, index)) continue;
    const parsed = parseFileToken(text, index + 1);
    if (!parsed) continue;
    const normalized = normalizePathToken(parsed.value);
    if (!knownPaths.has(normalized) && !looksLikeWorkspaceFilePath(parsed.value)) continue;
    candidates.push({
      kind: "file",
      start: index,
      end: parsed.end,
      label: parsed.value,
      value: parsed.value,
      priority: TOKEN_PRIORITIES.file,
    });
  }
  return candidates;
}

function linkTokenCandidates(text: string): ComposerTokenCandidate[] {
  const candidates: ComposerTokenCandidate[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    let end = start + match[0].length;
    while (end > start && /[.,;:!?)}\]]/.test(text[end - 1])) end -= 1;
    if (end <= start) continue;
    const value = text.slice(start, end);
    candidates.push({
      kind: "link",
      start,
      end,
      label: value,
      value,
      priority: TOKEN_PRIORITIES.link,
    });
  }
  return candidates;
}

function selectTokenCandidates(candidates: ComposerTokenCandidate[]): ComposerToken[] {
  const selected: ComposerToken[] = [];
  const sorted = candidates.slice().sort((a, b) =>
    a.start - b.start ||
    a.priority - b.priority ||
    (b.end - b.start) - (a.end - a.start) ||
    a.label.localeCompare(b.label),
  );
  let cursor = 0;
  for (const candidate of sorted) {
    if (candidate.start < cursor) continue;
    const { priority: _priority, ...token } = candidate;
    selected.push(token);
    cursor = token.end;
  }
  return selected;
}

function parseFileToken(text: string, start: number): { value: string; end: number } | null {
  if (text[start] === "\"") {
    const endQuote = text.indexOf("\"", start + 1);
    if (endQuote <= start + 1) return null;
    return { value: text.slice(start + 1, endQuote), end: endQuote + 1 };
  }
  let end = start;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  if (end === start) return null;
  return { value: text.slice(start, end), end };
}

function looksLikeWorkspaceFilePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,12}$/.test(value);
}

function normalizePathToken(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

function matchNameAt(text: string, start: number, name: string): number | null {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  let cursor = start;
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex];
    if (text.slice(cursor, cursor + part.length).toLowerCase() !== part.toLowerCase()) {
      return null;
    }
    cursor += part.length;
    if (partIndex < parts.length - 1) {
      const next = cursor;
      while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
      if (cursor === next) return null;
    }
  }
  return cursor;
}

function isTagStartBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return /\s|[([{]/.test(text[index - 1]);
}

function isTagEndBoundary(text: string, index: number): boolean {
  if (index >= text.length) return true;
  return /\s|[,.;:!?()[\]{}"'`]/.test(text[index]);
}
