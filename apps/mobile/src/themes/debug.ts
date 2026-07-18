import { Easing } from 'react-native';
import { createTheme } from './registry';
import { original } from './original';

/**
 * Dev-only coverage probe — deliberately garish so any surface still rendering
 * Original values screams. Never shipped in the release picker (registered
 * behind __DEV__ in registry.ts). If a screen looks "normal" under Debug, its
 * styles haven't been migrated to useThemedStyles/tokens yet.
 */
export const debug = createTheme(original, {
  id: 'debug',
  name: 'Debug (dev)',
  dark: false,
  colors: {
    background: '#FFE4F1', surface: '#FFFBEA',
    border: '#FF00AA', borderDetail: '#FF77CC',
    textPrimary: '#5B21B6', textSecondary: '#0E7490', textMuted: '#DB2777', textDisabled: '#A78BFA',
    brand: '#4C1D95', primary: '#FF6600', primaryText: '#C2410C',
    primaryBg: '#FFEDD5', primaryBgStrong: '#FED7AA',
    accent: '#00C2FF', accentBg: '#CFF8FF',
    warning: '#FF00AA', danger: '#00A86B', dangerBg: '#B5FFE1', success: '#FF3B3B',
    onPrimary: '#00131F',
    surfaceAlt: '#D9F99D',
    textStrong: '#7C2D12',
    backdrop: 'rgba(120,0,120,0.55)',
    successBg: '#FFD6D6', successText: '#7F1D1D',
    warningBg: '#DBEAFE', warningText: '#1E3A8A',
    headerBg: '#FF6600', headerTint: '#1E1B4B',
    inputBg: '#ECFEFF', inputBorder: '#FF00AA', inputText: '#5B21B6', placeholder: '#0E7490',
  },
  typography: { letterSpacing: 0.5, uppercaseLabels: true },
  radii: { sm: 0, md: 2, lg: 4, xl: 6, input: 0, button: 24, card: 2, sheet: 0, pill: 4, fab: 4 },
  motion: {
    duration: { fast: 400, base: 600, slow: 900 },
    easing: Easing.bounce,
    spring: null,
    pressFeedback: 'scale',
    enabled: true,
  },
  components: {
    input: { variant: 'filled', height: 52, borderWidth: 3 },
    button: { variant: 'soft', textTransform: 'uppercase', minHeight: 56 },
    sheet: { presentation: 'center-dialog', showHandle: false, topRadius: 0, maxHeightPct: 70 },
    alert: { presentation: 'slide-up', buttonLayout: 'stacked', maxWidth: 300 },
    fab: { shape: 'rounded-square', size: 64 },
    card: { borderWidth: 3, divided: true },
    chip: { variant: 'square-tag' },
  },
});
