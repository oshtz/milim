import type { UpdateDownloadProgress } from "./service";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function phaseLabel(phase: UpdateDownloadProgress["phase"]): string {
  if (phase === "verifying") return "Verifying update";
  if (phase === "preparing") return "Preparing update";
  if (phase === "restarting") return "Restarting milim";
  return "Downloading update";
}

export function UpdateProgress({
  progress,
  className = "",
}: {
  progress: UpdateDownloadProgress;
  className?: string;
}) {
  const hasTotal = progress.totalBytes !== null && progress.totalBytes > 0;
  const percent = hasTotal
    ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes!) * 100))
    : null;
  const label = phaseLabel(progress.phase);
  const detail = progress.phase === "downloading"
    ? hasTotal
      ? `${percent}% · ${formatBytes(progress.downloadedBytes)} of ${formatBytes(progress.totalBytes!)}`
      : progress.downloadedBytes > 0
        ? formatBytes(progress.downloadedBytes)
        : "Starting..."
    : progress.phase === "restarting"
      ? "The app will reopen automatically."
      : "Please wait...";

  return (
    <div className={`update-progress${className ? ` ${className}` : ""}`} data-testid="update-progress">
      <div className="update-progress-copy" aria-live="polite">
        <strong>{label}</strong>
        <span>{detail}</span>
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-valuetext={detail}
      >
        <div
          className={`progress-fill${percent === null ? " indeterminate" : ""}`}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}
