import type { ChatMessage } from "../api";

export const NO_FOLDER_ARTIFACT_INSTRUCTIONS = [
  "Milim captures named fenced code blocks into the current chat's artifact panel.",
  "When no working folder is selected and the user asks you to create a file, web app, document, dataset, or other generated artifact, return the artifact inline instead of asking for a folder.",
  "Use fenced blocks with filename metadata, for example ```html file=index.html ... ```; for multi-file artifacts, return one named fenced block per relative file path.",
  "For browser apps, use index.html plus sibling CSS/JS/TS/TSX files when that is clearer; the preview resolves relative links and imports across those artifacts.",
  "Ask for a folder only when the user wants you to read, modify, run, or save directly against existing local project files.",
].join(" ");

export function threadArtifactInstructionMessages(folder: string): ChatMessage[] {
  return folder.trim()
    ? []
    : [{ role: "system", content: NO_FOLDER_ARTIFACT_INSTRUCTIONS }];
}

export const PLAN_MODE_INSTRUCTIONS = [
  "Milim Plan Mode is active for this turn.",
  "Use only read-only inspection tools that are available to understand the request and relevant files.",
  "Do not edit files, write files, run commands, control the computer, create schedules, register memories, or perform other mutations.",
  "After inspecting enough context, return an inline implementation plan that is concrete enough to execute.",
  "Do not implement the plan until the user approves execution.",
].join("\n");

export function planModeInstructionMessages(active: boolean): ChatMessage[] {
  return active ? [{ role: "system", content: PLAN_MODE_INSTRUCTIONS }] : [];
}
