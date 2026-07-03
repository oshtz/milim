import type { ChatArtifact, ChatMessage } from "../api";

export interface ArtifactRevision {
  key: string;
  revisionNumber: number;
  totalRevisions: number;
  messageIndex: number;
  artifactIndex: number;
  artifact: ChatArtifact;
  artifacts: ChatArtifact[];
}

export interface ArtifactRevisionGroup {
  key: string;
  label: string;
  revisions: ArtifactRevision[];
  latest: ArtifactRevision;
}

export interface ArtifactRevisionChoice {
  revision: ArtifactRevision;
  group: ArtifactRevisionGroup;
}

export function artifactOccurrenceKey(messageIndex: number, artifactIndex: number): string {
  return `${messageIndex}:${artifactIndex}`;
}

export function artifactRevisionGroups(messages: readonly ChatMessage[]): ArtifactRevisionGroup[] {
  const groups = new Map<string, { label: string; revisions: ArtifactRevision[] }>();
  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant" || !message.artifacts?.length) return;
    message.artifacts.forEach((artifact, artifactIndex) => {
      const key = artifactRevisionKey(artifact, messageIndex, artifactIndex);
      const existing = groups.get(key) ?? { label: artifactLabel(artifact), revisions: [] };
      existing.revisions.push({
        key,
        revisionNumber: 0,
        totalRevisions: 0,
        messageIndex,
        artifactIndex,
        artifact,
        artifacts: message.artifacts ?? [artifact],
      });
      groups.set(key, existing);
    });
  });

  return Array.from(groups.entries()).map(([key, group]) => {
    const total = group.revisions.length;
    const revisions = group.revisions.map((revision, index) => ({
      ...revision,
      revisionNumber: index + 1,
      totalRevisions: total,
    }));
    return { key, label: group.label, revisions, latest: revisions[revisions.length - 1] };
  });
}

export function artifactRevisionChoiceByOccurrence(groups: readonly ArtifactRevisionGroup[]): Map<string, ArtifactRevisionChoice> {
  const byOccurrence = new Map<string, ArtifactRevisionChoice>();
  for (const group of groups) {
    for (const revision of group.revisions) {
      byOccurrence.set(artifactOccurrenceKey(revision.messageIndex, revision.artifactIndex), { revision, group });
    }
  }
  return byOccurrence;
}

export function artifactRevisionKey(artifact: ChatArtifact, messageIndex: number, artifactIndex: number): string {
  if (artifact.filename?.trim()) return `path:${normalizeArtifactLabel(artifact.filename)}`;
  if (/^Code block \d+$/i.test(artifact.title.trim())) {
    return `inline:${messageIndex}:${artifactIndex}:${artifact.id}`;
  }
  return `title:${artifact.kind}:${artifact.language ?? ""}:${normalizeArtifactLabel(artifact.title)}`;
}

function artifactLabel(artifact: ChatArtifact): string {
  return artifact.filename?.trim() || artifact.title.trim() || "Artifact";
}

function normalizeArtifactLabel(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/").toLowerCase();
}
