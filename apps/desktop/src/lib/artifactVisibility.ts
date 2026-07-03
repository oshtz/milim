import type { ChatMessage } from "../api.js";
import { isPreviewableArtifact } from "./artifacts.js";

export function hiddenArtifactIdsForMessage(message: ChatMessage, hideAllInlineArtifacts: boolean): ReadonlySet<string> | undefined {
  if (!message.content) return undefined;
  const ids = message.artifacts
    ?.filter((artifact) => message.content.includes(artifact.content) && (hideAllInlineArtifacts || isPreviewableArtifact(artifact)))
    .map((artifact) => artifact.id) ?? [];
  return ids.length ? new Set(ids) : undefined;
}
