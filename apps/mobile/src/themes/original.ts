import { Easing } from 'react-native';
import type { Theme } from './types';

/**
 * "Original" — the app's launch design (emerald/slate), extracted verbatim from
 * the pre-theme src/theme.ts plus semantic keys for the values that were
 * hardcoded at call sites. Pixel parity with the pre-theme app on this theme is
 * the acceptance test for the whole theming refactor: do not "improve" values
 * here — that's what the other themes are for.
 */
export const original: Theme = {
  id: 'original',
  name: 'Original',
  dark: false,
  colors: {
    background: '#F6F8F7', surface: '#fff',
    border: '#E2E8F0', borderDetail: '#EEF2F7',
    textPrimary: '#1E293B', textSecondary: '#64748B', textMuted: '#94A3B8', textDisabled: '#CBD5E1',
    brand: '#183028', primary: '#1E7E4E', primaryText: '#176B43',
    primaryBg: '#E8F1ED', primaryBgStrong: '#D3E6DC',
    accent: '#F28000', accentBg: '#FFF1E6',
    warning: '#F28000', danger: '#DC2626', dangerBg: '#FEE2E2', success: '#16A34A',
    onPrimary: '#fff',
    surfaceAlt: '#F1F5F9',
    textStrong: '#334155',
    backdrop: 'rgba(15,23,42,0.45)',
    successBg: '#D1FAE5', successText: '#065F46',
    warningBg: '#FEF3C7', warningText: '#92400E',
    headerBg: '#183028', headerTint: '#fff',
    inputBg: '#fff', inputBorder: '#E2E8F0', inputText: '#1E293B', placeholder: '#94A3B8',
  },
  typography: {
    fontFamily: { mono: 'monospace' },
    fontSizes: { xs: 10, sm: 11, caption: 12, body2: 13, body: 14, md: 15, base: 16, lg: 18, xl: 22 },
    weights: { regular: '400', medium: '500', semibold: '600', bold: '700' },
    letterSpacing: 0,
    uppercaseLabels: false,
  },
  spacing: { xs: 4, sm: 8, md: 12, base: 14, lg: 16, xl: 20, xxl: 24, xxxl: 32 },
  radii: {
    sm: 8, md: 10, lg: 12, xl: 20,
    input: 10, button: 12, card: 12, sheet: 20, pill: 999, fab: 27,
  },
  shadows: {
    none: {},
    card: { elevation: 1, shadowColor: '#0F172A', shadowOpacity: 0.06, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    // Matches the pre-theme inline FAB shadow exactly (screens' parity baseline).
    fab: { elevation: 5, shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
    sheet: { elevation: 8, shadowColor: '#0F172A', shadowOpacity: 0.15, shadowRadius: 16, shadowOffset: { width: 0, height: -4 } },
  },
  motion: {
    duration: { fast: 120, base: 200, slow: 300 },
    easing: Easing.out(Easing.quad),
    spring: null,
    pressFeedback: 'opacity',
    enabled: true,
  },
  components: {
    input: { variant: 'outlined', height: 44, borderWidth: 1 },
    button: { variant: 'filled', textTransform: 'none', minHeight: 48 },
    sheet: { presentation: 'slide-bottom', showHandle: true, topRadius: 20, maxHeightPct: 88 },
    alert: { presentation: 'fade', buttonLayout: 'row', maxWidth: 380 },
    fab: { shape: 'circle', size: 54 },
    card: { borderWidth: 1, divided: false },
    chip: { variant: 'pill' },
  },
};
