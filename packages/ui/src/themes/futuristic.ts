import { Easing } from 'react-native';
import { createTheme } from './createTheme';
import { original } from './original';

/**
 * "Futuristic" — dark sci-fi skin (#117), the app's first dark surface (it
 * doubles as the sweep audit: anything still hardcoding light values shows
 * immediately). Near-black blue, neon cyan primary + magenta accent, Rajdhani
 * headings + mono values, angular radii, glow-instead-of-elevation (Android
 * elevation shadows are invisible on dark), fast sharp motion.
 */
export const futuristic = createTheme(original, {
  id: 'futuristic',
  name: 'Futuristic',
  dark: true,
  colors: {
    background: '#070B14',
    surface: '#0D1420',
    border: '#1B2940',
    borderDetail: '#141F31',
    textPrimary: '#E2E8F0',
    textSecondary: '#7C8DB0',
    textMuted: '#4C5C7A',
    textDisabled: '#334361',
    textStrong: '#B7C4DE',
    brand: '#22D3EE',
    primary: '#22D3EE',
    primaryText: '#67E8F9',
    primaryBg: '#0B2530',
    primaryBgStrong: '#0E3440',
    accent: '#E879F9',
    accentBg: '#2A1030',
    warning: '#FBBF24',
    warningBg: '#2E2308',
    warningText: '#FCD34D',
    danger: '#F87171',
    dangerBg: '#2E0F0F',
    success: '#34D399',
    successBg: '#0A2A1E',
    successText: '#6EE7B7',
    onPrimary: '#04141A',
    surfaceAlt: '#111B2C',
    backdrop: 'rgba(0,10,20,0.7)',
    headerBg: '#0D1420',
    headerTint: '#22D3EE',
    inputBg: '#0A111C',
    inputBorder: '#1B2940',
    inputText: '#E2E8F0',
    placeholder: '#4C5C7A',
  },
  typography: {
    fontFamily: { medium: 'Rajdhani_600SemiBold', bold: 'Rajdhani_700Bold', mono: 'monospace' },
    weights: { regular: '400', medium: '600', semibold: '600', bold: '700' },
    letterSpacing: 1,
    uppercaseLabels: true,
  },
  radii: { sm: 0, md: 2, lg: 2, xl: 4, input: 2, button: 0, card: 2, sheet: 0, pill: 2, fab: 6 },
  shadows: {
    // Glow carries depth on dark — cyan halo instead of a drop shadow.
    card: { elevation: 0, shadowColor: '#22D3EE', shadowOpacity: 0.12, shadowRadius: 8, shadowOffset: { width: 0, height: 0 } },
    fab: { elevation: 0, shadowColor: '#E879F9', shadowOpacity: 0.5, shadowRadius: 10, shadowOffset: { width: 0, height: 0 } },
    sheet: { elevation: 0, shadowColor: '#22D3EE', shadowOpacity: 0.3, shadowRadius: 14, shadowOffset: { width: 0, height: 0 } },
  },
  motion: {
    duration: { fast: 90, base: 120, slow: 200 },
    easing: Easing.out(Easing.cubic),
    spring: null,
    pressFeedback: 'scale',
    enabled: true,
  },
  components: {
    input: { variant: 'outlined', height: 44, borderWidth: 1 },
    button: { variant: 'filled-glow', textTransform: 'uppercase', minHeight: 46 },
    sheet: { presentation: 'slide-fast', showHandle: false, topRadius: 0, maxHeightPct: 88 },
    alert: { presentation: 'slide-up', buttonLayout: 'stacked', maxWidth: 380 },
    fab: { shape: 'rounded-square', size: 52 },
    card: { borderWidth: 1, divided: false },
    chip: { variant: 'square-tag' },
  },
});
