import type { WorkspaceLauncher, WorkspaceLauncherId } from "../api";

export const WORKSPACE_LAUNCHER_HISTORY_LIMIT = 25;

export const WORKSPACE_LAUNCHER_ORDER: readonly WorkspaceLauncherId[] = [
  "vscode",
  "zed",
  "file_manager",
  "terminal",
  "git_bash",
  "wsl",
  "android_studio",
];

const WORKSPACE_LAUNCHER_MARKER_ORDER: readonly WorkspaceLauncherId[] = [
  "zed",
  "vscode",
];

const WORKSPACE_LAUNCHER_EDITOR_ORDER: readonly WorkspaceLauncherId[] = [
  "vscode",
  "zed",
  "android_studio",
];

const WORKSPACE_LAUNCHER_IDS = new Set<string>(WORKSPACE_LAUNCHER_ORDER);

export function isWorkspaceLauncherId(
  value: unknown,
): value is WorkspaceLauncherId {
  return typeof value === "string" && WORKSPACE_LAUNCHER_IDS.has(value);
}

export function normalizeWorkspaceLauncherHistory(
  value: unknown,
): Record<string, WorkspaceLauncherId> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(
      (entry): entry is [string, WorkspaceLauncherId] =>
        Boolean(entry[0].trim()) && isWorkspaceLauncherId(entry[1]),
    )
    .slice(-WORKSPACE_LAUNCHER_HISTORY_LIMIT);
  return Object.fromEntries(entries);
}

export function rememberWorkspaceLauncherInHistory(
  history: Record<string, WorkspaceLauncherId>,
  folder: string,
  launcherId: WorkspaceLauncherId,
): Record<string, WorkspaceLauncherId> {
  const normalizedFolder = folder.trim();
  const normalized = normalizeWorkspaceLauncherHistory(history);
  if (!normalizedFolder || !isWorkspaceLauncherId(launcherId)) return normalized;
  delete normalized[normalizedFolder];
  normalized[normalizedFolder] = launcherId;
  return Object.fromEntries(
    Object.entries(normalized).slice(-WORKSPACE_LAUNCHER_HISTORY_LIMIT),
  );
}

function launcherOrder(id: WorkspaceLauncherId): number {
  const index = WORKSPACE_LAUNCHER_ORDER.indexOf(id);
  return index === -1 ? WORKSPACE_LAUNCHER_ORDER.length : index;
}

function availableById(
  launchers: WorkspaceLauncher[],
  id?: WorkspaceLauncherId,
): WorkspaceLauncher | null {
  if (!id) return null;
  return launchers.find((launcher) => launcher.id === id && launcher.available) ?? null;
}

export function recommendWorkspaceLauncher(
  launchers: WorkspaceLauncher[],
  folder: string,
  lastUsedByFolder: Record<string, WorkspaceLauncherId>,
): WorkspaceLauncher | null {
  const available = launchers.filter((launcher) => launcher.available);
  if (!available.length) return null;

  const lastUsed = normalizeWorkspaceLauncherHistory(lastUsedByFolder)[folder.trim()];
  const lastUsedLauncher = availableById(available, lastUsed);
  if (lastUsedLauncher) {
    return { ...lastUsedLauncher, recommendedReason: "Last used here" };
  }

  for (const id of WORKSPACE_LAUNCHER_MARKER_ORDER) {
    const markerLauncher = available.find(
      (launcher) => launcher.id === id && launcher.recommendedReason?.trim(),
    );
    if (markerLauncher) return markerLauncher;
  }

  for (const id of WORKSPACE_LAUNCHER_EDITOR_ORDER) {
    const editorLauncher = availableById(available, id);
    if (editorLauncher) {
      return { ...editorLauncher, recommendedReason: "Available editor" };
    }
  }

  return availableById(available, "file_manager") ?? available[0] ?? null;
}

export function rankedWorkspaceLaunchers(
  launchers: WorkspaceLauncher[],
  folder: string,
  lastUsedByFolder: Record<string, WorkspaceLauncherId>,
): WorkspaceLauncher[] {
  const recommended = recommendWorkspaceLauncher(
    launchers,
    folder,
    lastUsedByFolder,
  );
  return [...launchers].sort((a, b) => {
    if (recommended) {
      if (a.id === recommended.id && b.id !== recommended.id) return -1;
      if (b.id === recommended.id && a.id !== recommended.id) return 1;
    }
    if (a.available !== b.available) return a.available ? -1 : 1;
    return launcherOrder(a.id) - launcherOrder(b.id);
  }).map((launcher) =>
    recommended && launcher.id === recommended.id
      ? { ...launcher, recommendedReason: recommended.recommendedReason }
      : launcher,
  );
}
