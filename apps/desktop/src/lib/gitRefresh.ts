export const GIT_STATUS_REFRESH_INTERVAL_MS = 60_000;

export function shouldRefreshGitStatus(lastRunAt: number | null, now: number): boolean {
  return lastRunAt == null || now - lastRunAt >= GIT_STATUS_REFRESH_INTERVAL_MS;
}
