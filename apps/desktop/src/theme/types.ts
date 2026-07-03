// Theme model - a web mirror of milim's `ThemeProtocol`. Every field maps to
// a CSS variable (see applyTheme.ts), so a theme is fully data-driven and
// heavily customizable.

export interface ThemeColors {
  primaryText: string;
  secondaryText: string;
  tertiaryText: string;
  placeholderText: string;

  bgPrimary: string;
  bgSecondary: string;
  bgTertiary: string;
  sidebarBg: string;

  accent: string;
  accentLight: string;

  borderPrimary: string;
  borderSecondary: string;
  focusBorder: string;

  success: string;
  warning: string;
  error: string;
  info: string;

  cardBg: string;
  cardBorder: string;
  inputBg: string;
  inputBorder: string;
}

export interface ThemeGlass {
  /** Semi-transparent, blurred panels (so a background image shows through). */
  enabled: boolean;
  /** Backdrop blur radius, px. */
  blurRadius: number;
  /** Panel background opacity over the window background. */
  opacityPrimary: number;
  opacitySecondary: number;
  /** Top-edge highlight (rgba) for the glass bevel. */
  edgeLight: string;
}

export interface ThemeBackground {
  /** A `url(...)` image or a CSS gradient string; undefined = solid color. */
  image?: string;
  imageOpacity: number;
  /** Gaussian blur applied to the background image itself, in px (0 = none). */
  imageBlur?: number;
  /** A solid color drawn over the image/gradient (tint). */
  overlayColor?: string;
  overlayOpacity: number;
}

export interface ThemeBorders {
  cardRadius: number;
  inputRadius: number;
  borderOpacity: number;
}

export interface ThemeTypography {
  fontFamily: string;
  monoFamily: string;
}

export interface Theme {
  id: string;
  name: string;
  isDark: boolean;
  colors: ThemeColors;
  glass: ThemeGlass;
  background: ThemeBackground;
  borders: ThemeBorders;
  typography: ThemeTypography;
}

export const DEFAULT_TYPOGRAPHY: ThemeTypography = {
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, "Segoe UI", Roboto, sans-serif',
  monoFamily: 'ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", monospace',
};
