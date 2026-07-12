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
