import type { TextStyle, ViewStyle } from 'react-native';

/**
 * The full theme contract. Every visual lever the app exposes lives here:
 * tokens (colors/typography/spacing/radii/shadows), motion character, and
 * component variant descriptors that the shared primitives (AppInput,
 * PrimaryButton, ModalSheet, themedAlert, …) resolve at render time.
 *
 * Adding a theme later = one file of createTheme() diffs + one registry line.
 * Adding a NEW lever = extend this contract (and every theme file), never
 * special-case a component for a single theme.
 */

export interface ThemeColors {
  // Legacy keys — same names as the original src/theme.ts so the compat shim
  // and migrated call sites stay mechanical.
  background: string;
  surface: string;
  border: string;
  borderDetail: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  textDisabled: string;
  brand: string;
  primary: string;
  primaryText: string;
  primaryBg: string;
  primaryBgStrong: string;
  accent: string;
  accentBg: string;
  warning: string;
  danger: string;
  dangerBg: string;
  success: string;
  // Semantic keys for the hexes that were hardcoded across the app.
  onPrimary: string;      // text/spinner on primary+danger fills (was '#fff')
  surfaceAlt: string;     // chip/search-row fill (was '#F1F5F9')
  textStrong: string;     // emphasis between textPrimary and textSecondary (was '#334155'/'#475569')
  backdrop: string;       // modal/alert scrim (was 'rgba(15,23,42,0.45)')
  successBg: string;      // (was '#D1FAE5')
  successText: string;    // (was '#065F46')
  warningBg: string;      // (was '#FEF3C7')
  warningText: string;    // (was '#92400E')
  headerBg: string;       // nav header background (was colors.brand)
  headerTint: string;     // nav header text/icons (was '#fff')
  inputBg: string;
  inputBorder: string;
  inputText: string;
  placeholder: string;
}

export interface ThemeTypography {
  /** undefined = system font. mono always resolves (falls back to 'monospace'). */
  fontFamily: { regular?: string; medium?: string; bold?: string; mono: string };
  fontSizes: {
    xs: number; sm: number; caption: number; body2: number; body: number;
    md: number; base: number; lg: number; xl: number;
  };
  weights: {
    regular: TextStyle['fontWeight'];
    medium: TextStyle['fontWeight'];
    semibold: TextStyle['fontWeight'];
    bold: TextStyle['fontWeight'];
  };
  letterSpacing: number;
  /** Classic/Futuristic render section + field labels uppercase. */
  uppercaseLabels: boolean;
}

export interface ThemeSpacing {
  xs: number; sm: number; md: number; base: number;
  lg: number; xl: number; xxl: number; xxxl: number;
}

export interface ThemeRadii {
  // Legacy scale (kept so swept files translate 1:1)…
  sm: number; md: number; lg: number; xl: number;
  // …plus semantic radii — the real per-theme shape levers.
  input: number; button: number; card: number; sheet: number; pill: number; fab: number;
}

/** RN shadow fragments; the web style helper maps these to boxShadow (incl. glow). */
export type ShadowStyle = Pick<
  ViewStyle,
  'elevation' | 'shadowColor' | 'shadowOpacity' | 'shadowRadius' | 'shadowOffset'
>;

export interface ThemeShadows {
  none: ShadowStyle;
  card: ShadowStyle;
  fab: ShadowStyle;
  sheet: ShadowStyle;
}

export type PressFeedback = 'opacity' | 'scale' | 'highlight';

export interface ThemeMotion {
  duration: { fast: number; base: number; slow: number };
  easing: (t: number) => number;
  /** null = timing-only theme (no springs). */
  spring: { damping: number; stiffness: number } | null;
  pressFeedback: PressFeedback;
  /** false = flatten non-essential animation (Classic). */
  enabled: boolean;
}

export interface ThemeKeyboard {
  /** Breathing room kept between the focused field's bottom (caret) and the
   *  keyboard top. Maps to KeyboardAwareScrollView `bottomOffset`. The scroll
   *  animation itself is native + keyboard-synced (that is what makes it fluid),
   *  so this lever is the *offset*, not a duration. */
  focusExtraOffset: number;
}

export type SheetPresentation = 'slide-bottom' | 'center-dialog' | 'slide-fast' | 'spring-bottom';
export type AlertPresentation = 'fade' | 'fade-scale' | 'slide-up' | 'spring-pop';

export interface ThemeComponentSpec {
  input: {
    variant: 'outlined' | 'filled' | 'underlined';
    height: number;
    borderWidth: number;
  };
  button: {
    variant: 'filled' | 'filled-glow' | 'soft';
    textTransform: 'uppercase' | 'none';
    minHeight: number;
  };
  sheet: {
    presentation: SheetPresentation;
    showHandle: boolean;
    topRadius: number;
    maxHeightPct: number;
  };
  alert: {
    presentation: AlertPresentation;
    buttonLayout: 'row' | 'stacked';
    maxWidth: number;
  };
  fab: { shape: 'circle' | 'rounded-square' | 'pill'; size: number };
  card: { borderWidth: number; divided: boolean };
  chip: { variant: 'pill' | 'square-tag' };
}

export interface Theme {
  id: string;
  /** Display name in the picker. */
  name: string;
  /** Drives StatusBar style, web color-scheme, and dark-only fallbacks. */
  dark: boolean;
  colors: ThemeColors;
  typography: ThemeTypography;
  spacing: ThemeSpacing;
  radii: ThemeRadii;
  shadows: ThemeShadows;
  motion: ThemeMotion;
  components: ThemeComponentSpec;
  keyboard: ThemeKeyboard;
}

/** Recursive partial for createTheme() override files. Functions are replaced whole. */
export type ThemeOverrides = {
  [K in keyof Theme]?: Theme[K] extends object
    ? Theme[K] extends (...args: never[]) => unknown
      ? Theme[K]
      : { [K2 in keyof Theme[K]]?: Theme[K][K2] extends object
          ? Theme[K][K2] extends (...args: never[]) => unknown
            ? Theme[K][K2]
            : Partial<Theme[K][K2]>
          : Theme[K][K2] }
    : Theme[K];
};
