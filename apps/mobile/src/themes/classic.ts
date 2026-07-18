import { Easing } from 'react-native';
import { createTheme } from './createTheme';
import { original } from './original';

/**
 * "Classic" — dense traditional skin (#115). Conservative navy/gray, strong
 * borders instead of shadows, compressed spacing/type, uppercase labels,
 * near-square corners, minimal motion, and the signature center-dialog
 * ModalSheet presentation (desktop-dialog feel). Touch targets stay >= 44 —
 * density comes from padding, never hit area.
 */
export const classic = createTheme(original, {
  id: 'classic',
  name: 'Classic',
  colors: {
    background: '#EDEFF2',
    surface: '#FFFFFF',
    border: '#C7CDD6',
    borderDetail: '#D9DEE5',
    textPrimary: '#1A202C',
    textSecondary: '#4A5568',
    textStrong: '#2D3748',
    brand: '#1F4E79',
    primary: '#1F4E79',
    primaryText: '#173B5C',
    primaryBg: '#E3EAF2',
    primaryBgStrong: '#C9D7E6',
    accent: '#B7791F',
    accentBg: '#F6EDDD',
    warning: '#B7791F',
    backdrop: 'rgba(26,32,44,0.5)',
    headerBg: '#1F4E79',
    headerTint: '#FFFFFF',
    inputBg: '#FFFFFF',
    inputBorder: '#C7CDD6',
    inputText: '#1A202C',
    surfaceAlt: '#E4E7EC',
  },
  typography: {
    fontSizes: { xs: 9, sm: 10, caption: 11, body2: 12, body: 13, md: 14, base: 15, lg: 17, xl: 20 },
    weights: { regular: '400', medium: '500', semibold: '600', bold: '700' },
    letterSpacing: 0.3,
    uppercaseLabels: true,
  },
  spacing: { xs: 3, sm: 6, md: 10, base: 12, lg: 14, xl: 16, xxl: 20, xxxl: 26 },
  radii: { sm: 2, md: 3, lg: 4, xl: 6, input: 3, button: 4, card: 4, sheet: 6, pill: 4, fab: 8 },
  shadows: {
    card: {},
    fab: { elevation: 3, shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 2 } },
    sheet: {},
  },
  motion: {
    duration: { fast: 80, base: 100, slow: 160 },
    easing: Easing.out(Easing.linear),
    spring: null,
    pressFeedback: 'highlight',
    enabled: false,
  },
  components: {
    input: { variant: 'outlined', height: 44, borderWidth: 1 },
    button: { variant: 'filled', textTransform: 'uppercase', minHeight: 44 },
    sheet: { presentation: 'center-dialog', showHandle: false, topRadius: 6, maxHeightPct: 80 },
    alert: { presentation: 'fade', buttonLayout: 'row', maxWidth: 420 },
    fab: { shape: 'rounded-square', size: 52 },
    card: { borderWidth: 1, divided: true },
    chip: { variant: 'square-tag' },
  },
});
