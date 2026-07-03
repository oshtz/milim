import type { MediaKind, MediaModelSchema, MediaSchemaControl } from "../api";
import { controlValue } from "../lib/media";
import { Image } from "./icons";
import { Select } from "./ui";

export function InlineMediaControls({
  providerName,
  model,
  kind,
  supportedKinds = ["image", "video"],
  schema,
  schemaLoading,
  parameterValues,
  advanced,
  error,
  onKindChange,
  onParameterChange,
  onAdvancedChange,
}: {
  providerName: string;
  model: string;
  kind: MediaKind;
  supportedKinds?: MediaKind[];
  schema: MediaModelSchema | null;
  schemaLoading: boolean;
  parameterValues: Record<string, unknown>;
  advanced: string;
  error?: string | null;
  onKindChange: (kind: MediaKind) => void;
  onParameterChange: (control: MediaSchemaControl, value: string | boolean) => void;
  onAdvancedChange: (value: string) => void;
}) {
  const visibleKinds = supportedKinds.length ? supportedKinds : [kind];
  const activeKind = visibleKinds.includes(kind) ? kind : visibleKinds[0];

  return (
    <div className="inline-media" data-testid="inline-media-generator" title={`${providerName} / ${model}`}>
      <div className="inline-media-row">
        <div className="inline-media-head" title={`${providerName} / ${model}`}>
          <span className="inline-media-icon" aria-hidden="true"><Image size={14} /></span>
          <span className="inline-media-title">Media</span>
        </div>
        {visibleKinds.length > 1 && (
          <div className="inline-media-tabs" data-testid="inline-media-kind-tabs">
            {visibleKinds.map((item) => (
              <button
                key={item}
                type="button"
                className={activeKind === item ? "active" : ""}
                onClick={() => onKindChange(item)}
                aria-pressed={activeKind === item}
              >
                {item}
              </button>
            ))}
          </div>
        )}

        <div className="inline-media-parameter-controls" data-testid="inline-media-parameter-controls">
          {schemaLoading ? (
            <span className="sheet-hint">Loading parameters...</span>
          ) : (
            schema?.controls.map((control) => (
              <div
                className={"inline-media-field" + (control.kind === "array" || control.kind === "json" ? " wide" : "")}
                key={control.key}
              >
                <span title={control.description}>{control.label}</span>
                {control.kind === "select" ? (
                  <Select
                    testId={`inline-media-param-${control.key}`}
                    value={controlValue(parameterValues[control.key])}
                    options={(control.options ?? []).map((option) => ({
                      value: String(option.value),
                      label: option.label,
                    }))}
                    onChange={(value) => onParameterChange(control, value)}
                  />
                ) : control.kind === "checkbox" ? (
                  <input
                    className="media-checkbox-input"
                    data-testid={`inline-media-param-${control.key}`}
                    type="checkbox"
                    checked={Boolean(parameterValues[control.key])}
                    onChange={(e) => onParameterChange(control, e.target.checked)}
                  />
                ) : control.kind === "array" || control.kind === "json" ? (
                  <textarea
                    className="css-input"
                    data-testid={`inline-media-param-${control.key}`}
                    placeholder={control.placeholder}
                    value={controlValue(parameterValues[control.key])}
                    onChange={(e) => onParameterChange(control, e.target.value)}
                  />
                ) : (
                  <input
                    className="css-input"
                    data-testid={`inline-media-param-${control.key}`}
                    type={control.kind === "url" ? "url" : control.kind === "text" ? "text" : "number"}
                    placeholder={control.placeholder}
                    min={control.min}
                    max={control.max}
                    step={control.step}
                    value={controlValue(parameterValues[control.key])}
                    onChange={(e) => onParameterChange(control, e.target.value)}
                  />
                )}
              </div>
            ))
          )}
        </div>

        <details className="inline-media-advanced">
          <summary>Advanced</summary>
          <textarea
            className="css-input"
            data-testid="inline-media-advanced-input"
            value={advanced}
            spellCheck={false}
            onChange={(e) => onAdvancedChange(e.target.value)}
          />
        </details>
      </div>

      {error && <div className="artifact-error" data-testid="inline-media-error">{error}</div>}
    </div>
  );
}
