import type { CSSProperties, ChangeEvent, ReactNode } from "react";
import type {
  AvatarStyle,
  BackgroundFit,
  BackgroundTreatment,
  ChatLayoutStyle,
  CodeBlockTheme,
  MessageWidth,
} from "../ui/store";

type PreviewChoiceOption<T extends string> = {
  value: T;
  label: string;
  detail: string;
  preview: ReactNode;
  className?: string;
};

type BackgroundChoiceOption<T extends string> = {
  value: T;
  label: string;
  detail: string;
  glyph: string;
};

function PreviewChoiceGroup<T extends string>({
  value,
  options,
  onChange,
  testIdPrefix,
  ariaLabel,
  className = "",
}: {
  value: T;
  options: Array<PreviewChoiceOption<T>>;
  onChange: (value: T) => void;
  testIdPrefix: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div className={`appearance-choice-grid${className ? ` ${className}` : ""}`} role="radiogroup" aria-label={ariaLabel}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            className={`appearance-choice-card${option.className ? ` ${option.className}` : ""}${selected ? " active" : ""}`}
            type="button"
            role="radio"
            data-testid={`${testIdPrefix}-${option.value}`}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(option.value)}
          >
            {option.preview}
            <span className="appearance-choice-copy">
              <span>{option.label}</span>
              <small>{option.detail}</small>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function BackgroundChoiceGroup<T extends string>({
  value,
  options,
  onChange,
  testIdPrefix,
  ariaLabel,
}: {
  value: T;
  options: Array<BackgroundChoiceOption<T>>;
  onChange: (value: T) => void;
  testIdPrefix: string;
  ariaLabel: string;
}) {
  const selectedOption = options.find((option) => option.value === value) ?? options[0];

  return (
    <div className="appearance-background-control">
      <div className="appearance-background-segments" role="radiogroup" aria-label={ariaLabel}>
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              className={`appearance-background-option${selected ? " active" : ""}`}
              type="button"
              role="radio"
              data-testid={`${testIdPrefix}-${option.value}`}
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(option.value)}
            >
              <span className={`appearance-background-glyph ${option.glyph}`} aria-hidden="true" />
              <span className="appearance-background-option-label">{option.label}</span>
            </button>
          );
        })}
      </div>
      <small className="appearance-background-selection-detail" aria-live="polite">
        {selectedOption?.detail}
      </small>
    </div>
  );
}

function BackgroundImagePreview({
  backgroundImage,
  fit,
  treatment,
}: {
  backgroundImage: string;
  fit: BackgroundFit;
  treatment: BackgroundTreatment;
}) {
  return (
    <div
      className={`theme-editor-preview appearance-background-thumbnail bg-fit-${fit} bg-treatment-${treatment}`}
      data-testid="appearance-background-preview"
      role="img"
      aria-label="Selected background image preview"
      style={{ "--appearance-background-image": backgroundImage } as CSSProperties}
    >
      <span className="appearance-background-thumbnail-image" />
      <span className="theme-editor-preview-overlay appearance-background-thumbnail-overlay" />
      <span className="theme-editor-preview-sidebar appearance-background-thumbnail-sidebar">
        <span />
        <span />
        <span />
      </span>
      <span className="theme-editor-preview-panel appearance-background-thumbnail-panel">
        <span className="theme-editor-preview-topline">
          <span />
          <span />
        </span>
        <span className="theme-editor-preview-message" />
        <span className="theme-editor-preview-message compact" />
        <span className="theme-editor-preview-input" />
      </span>
    </div>
  );
}

function ChatLayoutPreview({ variant }: { variant: ChatLayoutStyle }) {
  return (
    <span className={`appearance-chat-preview ${variant}`} aria-hidden="true">
      {variant === "transcript" && (
        <>
          <span className="appearance-chat-line short" />
          <span className="appearance-chat-line long" />
          <span className="appearance-chat-line medium" />
        </>
      )}
      {variant === "bubbles" && (
        <>
          <span className="appearance-chat-bubble user" />
          <span className="appearance-chat-bubble assistant" />
          <span className="appearance-chat-bubble assistant short" />
        </>
      )}
      {variant === "compact" && (
        <>
          <span className="appearance-chat-log-row" />
          <span className="appearance-chat-log-row muted" />
          <span className="appearance-chat-log-row" />
          <span className="appearance-chat-log-row muted short" />
        </>
      )}
    </span>
  );
}

function MessageWidthSliderPreview({ width }: { width: MessageWidth }) {
  return (
    <span className={`appearance-width-slider-preview ${width}`} aria-hidden="true">
      <span className="appearance-width-frame">
        <span className="appearance-width-page">
          <span />
          <span />
          <span />
        </span>
      </span>
    </span>
  );
}

function AvatarPreview({ style }: { style: AvatarStyle }) {
  return (
    <span className={`appearance-avatar-preview ${style}`} aria-hidden="true">
      <span className="appearance-avatar-row user">
        <span className="appearance-avatar-mark">{style === "role" ? "You" : "U"}</span>
        <span className="appearance-avatar-text" />
      </span>
      <span className="appearance-avatar-row assistant">
        <span className="appearance-avatar-mark">{style === "role" ? "AI" : "A"}</span>
        <span className="appearance-avatar-text short" />
      </span>
    </span>
  );
}

function CodePreview({ theme }: { theme: CodeBlockTheme }) {
  return (
    <span className={`appearance-code-preview ${theme}`} aria-hidden="true">
      <span>
        <span className="token-keyword">const</span> model = <span className="token-string">"milim"</span>;
      </span>
      <span>
        <span className="token-keyword">return</span> run(model, <span className="token-number">42</span>);
      </span>
    </span>
  );
}

const CHAT_LAYOUT_OPTIONS: Array<PreviewChoiceOption<ChatLayoutStyle>> = [
  {
    value: "transcript",
    label: "Transcript",
    detail: "Assistant text stays open and flat.",
    preview: <ChatLayoutPreview variant="transcript" />,
  },
  {
    value: "bubbles",
    label: "Bubbles",
    detail: "Both sides render as message bubbles.",
    preview: <ChatLayoutPreview variant="bubbles" />,
  },
  {
    value: "compact",
    label: "Compact log",
    detail: "Tighter spacing for long sessions.",
    preview: <ChatLayoutPreview variant="compact" />,
  },
];

const MESSAGE_WIDTH_STOPS: Array<{
  value: MessageWidth;
  label: string;
  detail: string;
}> = [
  {
    value: "narrow",
    label: "Narrow",
    detail: "Shorter line length.",
  },
  {
    value: "standard",
    label: "Standard",
    detail: "Current reading width.",
  },
  {
    value: "wide",
    label: "Wide",
    detail: "More horizontal room.",
  },
  {
    value: "full",
    label: "Full",
    detail: "Use the full chat pane.",
  },
];

const AVATAR_OPTIONS: Array<PreviewChoiceOption<AvatarStyle>> = [
  {
    value: "none",
    label: "None",
    detail: "Keep the current clean transcript.",
    preview: <AvatarPreview style="none" />,
  },
  {
    value: "initials",
    label: "Initials",
    detail: "Small role marks beside messages.",
    preview: <AvatarPreview style="initials" />,
  },
  {
    value: "role",
    label: "Role labels",
    detail: "Text labels for sender scanning.",
    preview: <AvatarPreview style="role" />,
  },
];

const CODE_BLOCK_OPTIONS: Array<PreviewChoiceOption<CodeBlockTheme>> = [
  {
    value: "match",
    label: "Match app",
    detail: "Use the active theme colors.",
    preview: <CodePreview theme="match" />,
    className: "code-choice-match",
  },
  {
    value: "terminal",
    label: "Terminal",
    detail: "Dark console-style contrast.",
    preview: <CodePreview theme="terminal" />,
    className: "code-choice-terminal",
  },
  {
    value: "github",
    label: "GitHub",
    detail: "Light editor-style blocks.",
    preview: <CodePreview theme="github" />,
    className: "code-choice-github",
  },
  {
    value: "high-contrast",
    label: "High contrast",
    detail: "Maximum code legibility.",
    preview: <CodePreview theme="high-contrast" />,
    className: "code-choice-high-contrast",
  },
];

const BACKGROUND_FIT_OPTIONS: Array<BackgroundChoiceOption<BackgroundFit>> = [
  {
    value: "cover",
    label: "Cover",
    detail: "Fill the window.",
    glyph: "fit-cover",
  },
  {
    value: "contain",
    label: "Contain",
    detail: "Show the whole image.",
    glyph: "fit-contain",
  },
  {
    value: "center",
    label: "Center",
    detail: "Original size, centered.",
    glyph: "fit-center",
  },
  {
    value: "tile",
    label: "Tile",
    detail: "Repeat as a pattern.",
    glyph: "fit-tile",
  },
];

const BACKGROUND_TREATMENT_OPTIONS: Array<BackgroundChoiceOption<BackgroundTreatment>> = [
  {
    value: "clear",
    label: "Clear",
    detail: "Use the theme image as-is.",
    glyph: "treatment-clear",
  },
  {
    value: "dim",
    label: "Dim",
    detail: "Darken for calmer contrast.",
    glyph: "treatment-dim",
  },
  {
    value: "blur",
    label: "Blur",
    detail: "Soften busy images.",
    glyph: "treatment-blur",
  },
  {
    value: "mono",
    label: "Mono",
    detail: "Desaturate the image.",
    glyph: "treatment-mono",
  },
];

export function AppearanceChatLayoutChoices({
  value,
  onChange,
}: {
  value: ChatLayoutStyle;
  onChange: (value: ChatLayoutStyle) => void;
}) {
  return (
    <PreviewChoiceGroup
      value={value}
      onChange={onChange}
      testIdPrefix="appearance-chat-layout"
      ariaLabel="Chat layout"
      options={CHAT_LAYOUT_OPTIONS}
      className="appearance-chat-layout-grid"
    />
  );
}

export function AppearanceMessageWidthChoices({
  value,
  onChange,
}: {
  value: MessageWidth;
  onChange: (value: MessageWidth) => void;
}) {
  const selectedIndex = Math.max(
    0,
    MESSAGE_WIDTH_STOPS.findIndex((option) => option.value === value),
  );
  const selectedOption = MESSAGE_WIDTH_STOPS[selectedIndex] ?? MESSAGE_WIDTH_STOPS[0];
  const sliderProgress = Math.round((selectedIndex / (MESSAGE_WIDTH_STOPS.length - 1)) * 100);

  const handleSliderChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextOption = MESSAGE_WIDTH_STOPS[Number(event.currentTarget.value)];
    if (nextOption) onChange(nextOption.value);
  };

  return (
    <div className={`appearance-width-control index-${selectedIndex}`}>
      <div className="appearance-width-control-top">
        <MessageWidthSliderPreview width={selectedOption.value} />
        <span className="appearance-width-slider-copy">
          <span>{selectedOption.label}</span>
          <small>{selectedOption.detail}</small>
        </span>
      </div>
      <div className="appearance-width-slider-shell">
        <input
          className="appearance-width-range"
          type="range"
          role="slider"
          min={0}
          max={MESSAGE_WIDTH_STOPS.length - 1}
          step={1}
          value={selectedIndex}
          aria-label="Message width"
          aria-valuemin={0}
          aria-valuemax={MESSAGE_WIDTH_STOPS.length - 1}
          aria-valuenow={selectedIndex}
          aria-valuetext={selectedOption.label}
          data-testid="appearance-message-width-slider"
          style={{ "--appearance-width-progress": `${sliderProgress}%` } as CSSProperties}
          onChange={handleSliderChange}
        />
      </div>
      <div className="appearance-width-stops" role="radiogroup" aria-label="Message width presets">
        {MESSAGE_WIDTH_STOPS.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              className={`appearance-width-stop${selected ? " active" : ""}`}
              type="button"
              role="radio"
              data-testid={`appearance-message-width-${option.value}`}
              aria-checked={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function AppearanceAvatarChoices({
  value,
  onChange,
}: {
  value: AvatarStyle;
  onChange: (value: AvatarStyle) => void;
}) {
  return (
    <PreviewChoiceGroup
      value={value}
      onChange={onChange}
      testIdPrefix="appearance-avatar-style"
      ariaLabel="Avatar style"
      options={AVATAR_OPTIONS}
      className="appearance-avatar-grid"
    />
  );
}

export function AppearanceCodeBlockThemeChoices({
  value,
  onChange,
}: {
  value: CodeBlockTheme;
  onChange: (value: CodeBlockTheme) => void;
}) {
  return (
    <PreviewChoiceGroup
      value={value}
      onChange={onChange}
      testIdPrefix="appearance-code-theme"
      ariaLabel="Code block theme"
      options={CODE_BLOCK_OPTIONS}
    />
  );
}

export function AppearanceBackgroundImageChoices({
  backgroundImage,
  fit,
  treatment,
  onFitChange,
  onTreatmentChange,
}: {
  backgroundImage?: string;
  fit: BackgroundFit;
  treatment: BackgroundTreatment;
  onFitChange: (value: BackgroundFit) => void;
  onTreatmentChange: (value: BackgroundTreatment) => void;
}) {
  if (!backgroundImage?.trim()) return null;

  return (
    <div className="appearance-background-layout">
      <BackgroundImagePreview backgroundImage={backgroundImage} fit={fit} treatment={treatment} />
      <div className="appearance-background-controls">
        <div className="appearance-background-field">
          <span className="setting-mini-title">Fit</span>
          <BackgroundChoiceGroup
            value={fit}
            onChange={onFitChange}
            testIdPrefix="appearance-background-fit"
            ariaLabel="Background image fit"
            options={BACKGROUND_FIT_OPTIONS}
          />
        </div>
        <div className="appearance-background-field">
          <span className="setting-mini-title">Treatment</span>
          <BackgroundChoiceGroup
            value={treatment}
            onChange={onTreatmentChange}
            testIdPrefix="appearance-background-treatment"
            ariaLabel="Background image treatment"
            options={BACKGROUND_TREATMENT_OPTIONS}
          />
        </div>
      </div>
    </div>
  );
}
