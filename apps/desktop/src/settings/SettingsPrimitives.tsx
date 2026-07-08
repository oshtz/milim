import { type HTMLAttributes, type ReactNode } from "react";

export function SettingsPanel({ children, ...props }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return <div className="settings-panel" {...props}>{children}</div>;
}

export function SettingsBlock({
  title,
  className = "",
  children,
  ...props
}: { title: string; className?: string; children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`settings-block${className ? ` ${className}` : ""}`} {...props}>
      <div className="settings-block-title">{title}</div>
      {children}
    </div>
  );
}

export function SettingsChoiceGroup<T extends string>({
  value,
  options,
  onChange,
  testIdPrefix,
}: {
  value: T;
  options: Array<{ value: T; label: string; detail: string }>;
  onChange: (value: T) => void;
  testIdPrefix: string;
}) {
  return (
    <div className="settings-choice-grid" role="radiogroup" aria-label={testIdPrefix.replace(/-/g, " ")}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            className={"settings-choice-button" + (selected ? " active" : "")}
            type="button"
            role="radio"
            data-testid={`${testIdPrefix}-${option.value}`}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            <small>{option.detail}</small>
          </button>
        );
      })}
    </div>
  );
}

export function FieldIssue({ message }: { message?: string | null }) {
  return message ? <span className="setting-field-error">{message}</span> : null;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

export function PresetInstallProgress({
  doneLabel,
  progress,
  percent,
  phaseLabel,
  onCancel,
}: {
  doneLabel: string;
  progress: { done?: boolean; downloaded?: number | null; total?: number | null } | null;
  percent: number | null;
  phaseLabel: string;
  onCancel?: () => void;
}) {
  if (progress?.done) return <div className="model-progress piper-install-progress"><span className="model-ok">{doneLabel}</span></div>;
  return (
    <div className="model-progress piper-install-progress">
      <div className="progress-track">
        <div
          className={"progress-fill" + (percent == null ? " indeterminate" : "")}
          style={{ width: percent != null ? `${percent}%` : "40%" }}
        />
      </div>
      <span className="progress-label">
        {phaseLabel}
        {progress?.downloaded != null ? ` ${fmtBytes(progress.downloaded)}` : ""}
        {progress?.total ? ` / ${fmtBytes(progress.total)}` : ""}
        {percent != null ? ` (${percent}%)` : " ..."}
      </span>
      {onCancel && (
        <button className="btn-ghost" type="button" onClick={onCancel}>
          Cancel
        </button>
      )}
    </div>
  );
}
