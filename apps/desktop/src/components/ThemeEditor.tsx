import { useState } from "react";
import { useTheme } from "../theme/store";
import type { Theme } from "../theme/types";
import { SheetDialog } from "./SheetDialog";
import { ColorField, Select, Slider as Range, Toggle } from "./ui";

const COLOR_FIELDS: Array<[string, keyof Theme["colors"]]> = [
  ["Background", "bgPrimary"],
  ["Surface", "bgSecondary"],
  ["Elevated", "bgTertiary"],
  ["Text", "primaryText"],
  ["Muted text", "secondaryText"],
  ["Accent", "accent"],
  ["Accent light", "accentLight"],
  ["Border", "borderPrimary"],
  ["Card", "cardBg"],
  ["Input", "inputBg"],
];

const FONT_PRESETS: Array<[string, string]> = [
  ["System", '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif'],
  ["Inter", "Inter, system-ui, sans-serif"],
  ["Segoe UI", '"Segoe UI", system-ui, sans-serif'],
  ["Helvetica", "Helvetica, Arial, sans-serif"],
  ["Georgia (serif)", 'Georgia, "Times New Roman", serif'],
  ["Verdana", "Verdana, Geneva, sans-serif"],
];
const MONO_PRESETS: Array<[string, string]> = [
  ["System mono", 'ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", monospace'],
  ["Cascadia Code", '"Cascadia Code", "Cascadia Mono", monospace'],
  ["Consolas", 'Consolas, "Courier New", monospace'],
  ["JetBrains Mono", '"JetBrains Mono", monospace'],
  ["Courier", '"Courier New", Courier, monospace'],
];

function newId() {
  try {
    return "custom-" + crypto.randomUUID();
  } catch {
    return "custom-" + Math.random().toString(36).slice(2);
  }
}

export function ThemeEditor({ base, isNew, onClose }: { base: Theme; isNew: boolean; onClose: () => void }) {
  const { saveCustom, deleteCustom, revert, preview } = useTheme();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [draft, setDraft] = useState<Theme>(() => {
    const d = structuredClone(base);
    if (isNew) {
      d.id = newId();
      d.name = "My " + base.name;
    }
    return d;
  });

  function patch(mutate: (d: Theme) => void) {
    setConfirmDelete(false);
    setDraft((prev) => {
      const d = structuredClone(prev);
      mutate(d);
      preview(d);
      return d;
    });
  }

  function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () =>
      patch((d) => {
        d.background.image = `url(${reader.result as string})`;
        d.background.imageOpacity = 1;
        d.glass.enabled = true;
      });
    reader.readAsDataURL(file);
  }

  function deleteDraft() {
    if (confirmDelete) {
      deleteCustom(draft.id);
      onClose();
      return;
    }
    setConfirmDelete(true);
  }

  return (
    <SheetDialog
      title={isNew ? "Customize theme" : "Edit theme"}
      className="sheet editor"
      testId="theme-editor"
      onClose={() => { revert(); onClose(); }}
    >
      <div className="sheet-header editor-header">
        <div className="editor-title">
          <span className="editor-kicker">{isNew ? "New theme" : "Custom theme"}</span>
          <input
            className="name-input"
            value={draft.name}
            onChange={(e) => patch((d) => { d.name = e.target.value; })}
            placeholder="Theme name"
            aria-label="Theme name"
          />
        </div>
        <div className="editor-actions">
          {!isNew && (
            <button
              className="btn-ghost danger"
              type="button"
              title={confirmDelete ? "Click again to delete this theme" : "Delete theme"}
              aria-label={confirmDelete ? `Confirm delete ${draft.name}` : `Delete ${draft.name}`}
              onClick={deleteDraft}
            >
              {confirmDelete ? "Confirm delete" : "Delete"}
            </button>
          )}
          <button className="btn-ghost" type="button" onClick={() => { revert(); onClose(); }}>Cancel</button>
          <button className="btn-accent" type="button" onClick={() => { saveCustom(draft); onClose(); }}>Save</button>
        </div>
      </div>

      <div className="editor-body">
        <div className="editor-main">
          <section className="editor-section editor-section-colors">
            <h3>Colors</h3>
            <div className="color-grid">
              {COLOR_FIELDS.map(([label, key]) => (
                <ColorField
                  key={key}
                  label={label}
                  value={draft.colors[key]}
                  onChange={(v) => patch((d) => { d.colors[key] = v; })}
                />
              ))}
            </div>
            <Toggle
              checked={draft.isDark}
              onChange={(v) => patch((d) => { d.isDark = v; })}
              label="Dark theme (affects contrast on the accent)"
            />
          </section>

          <section className="editor-section">
            <h3>Background</h3>
            <div className="bg-row">
              <label className="btn-file">
                Upload image
                <input type="file" accept="image/*" onChange={onUpload} hidden />
              </label>
              {draft.background.image && (
                <button className="btn-ghost" type="button" onClick={() => patch((d) => { d.background.image = undefined; })}>
                  Clear image
                </button>
              )}
            </div>
            <label className="text-row">
              <span>Image / gradient (CSS)</span>
              <input
                className="css-input"
                value={draft.background.image ?? ""}
                placeholder="url(...) or linear-gradient(...)"
                onChange={(e) => patch((d) => { d.background.image = e.target.value || undefined; })}
              />
            </label>
            <Slider label="Image blur" min={0} max={40} step={1} value={draft.background.imageBlur ?? 0}
              onChange={(v) => patch((d) => { d.background.imageBlur = v; })} />
            <ColorField
              label="Overlay tint"
              value={draft.background.overlayColor ?? "#000000"}
              onChange={(v) => patch((d) => { d.background.overlayColor = v; })}
            />
            <div style={{ height: 4 }} />
            <Slider label="Overlay opacity" min={0} max={0.85} step={0.02} value={draft.background.overlayOpacity}
              onChange={(v) => patch((d) => { d.background.overlayOpacity = v; })} />
          </section>

          <section className="editor-section">
            <h3>Typography</h3>
            <label className="text-row">
              <span>Font</span>
              <Select
                value={draft.typography.fontFamily}
                options={FONT_PRESETS.map(([label, val]) => ({ label, value: val }))}
                onChange={(v) => patch((d) => { d.typography.fontFamily = v; })}
              />
            </label>
            <label className="text-row">
              <span>Code font</span>
              <Select
                value={draft.typography.monoFamily}
                options={MONO_PRESETS.map(([label, val]) => ({ label, value: val }))}
                onChange={(v) => patch((d) => { d.typography.monoFamily = v; })}
              />
            </label>
          </section>
        </div>

        <aside className="editor-side">
          <section className="editor-preview-card" aria-label="Theme preview">
            <h3>Preview</h3>
            <div
              className="theme-editor-preview"
              style={{
                background: draft.background.image
                  ? `${draft.background.image}, ${draft.colors.bgPrimary}`
                  : draft.colors.bgPrimary,
              }}
            >
              <div
                className="theme-editor-preview-panel"
                style={{ background: draft.colors.bgSecondary, borderColor: draft.colors.borderPrimary }}
              >
                <div className="theme-editor-preview-topline">
                  <span style={{ background: draft.colors.accent }} />
                  <span style={{ background: draft.colors.tertiaryText }} />
                </div>
                <div className="theme-editor-preview-message" style={{ background: draft.colors.bgTertiary }} />
                <div className="theme-editor-preview-input" style={{ background: draft.colors.inputBg, borderColor: draft.colors.inputBorder }} />
              </div>
            </div>
            <div className="editor-swatch-row" aria-label="Theme color summary">
              {[
                draft.colors.bgPrimary,
                draft.colors.bgSecondary,
                draft.colors.primaryText,
                draft.colors.accent,
              ].map((color, index) => (
                <span key={`${color}-${index}`} style={{ background: color }} title={color} />
              ))}
            </div>
          </section>

          <section className="editor-section compact">
            <h3>Glass</h3>
            <Toggle
              checked={draft.glass.enabled}
              onChange={(v) => patch((d) => { d.glass.enabled = v; })}
              label="Translucent, blurred panels"
            />
            <Slider label="Blur" min={0} max={40} step={1} value={draft.glass.blurRadius} suffix="px"
              onChange={(v) => patch((d) => { d.glass.blurRadius = v; })} />
            <Slider label="Panel opacity" min={0.2} max={1} step={0.02} value={draft.glass.opacityPrimary}
              onChange={(v) => patch((d) => { d.glass.opacityPrimary = v; d.glass.opacitySecondary = Math.max(0.2, v - 0.15); })} />
          </section>

          <section className="editor-section compact">
            <h3>Shape</h3>
            <Slider label="Card radius" min={0} max={24} step={1} value={draft.borders.cardRadius} suffix="px"
              onChange={(v) => patch((d) => { d.borders.cardRadius = v; })} />
            <Slider label="Input radius" min={0} max={28} step={1} value={draft.borders.inputRadius} suffix="px"
              onChange={(v) => patch((d) => { d.borders.inputRadius = v; })} />
          </section>
        </aside>
      </div>
    </SheetDialog>
  );
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  suffix = "",
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="slider-row">
      <span className="slider-label">{label}</span>
      <Range min={min} max={max} step={step} value={value} onChange={onChange} />
      <span className="slider-val">{suffix === "px" ? Math.round(value) : value.toFixed(2)}{suffix}</span>
    </div>
  );
}
