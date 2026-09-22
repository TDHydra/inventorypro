import { Easing } from 'react-native';
import { createTheme } from './createTheme';
import { original } from './original';

/**
 * "Fluid" — soft rounded skin with spring motion (#116). Lavender-white
 * surfaces, soft violet primary, tonal borderless (filled) inputs with an
 * animated focus ring in AppInput, pill radii everywhere, Nunito, and
 * spring-driven sheets/alerts/presses (native-driver transform/opacity only —
 * layout properties never spring).
 */
export const fluid = createTheme(original, {
  id: 'fluid',
  name: 'Fluid',
  colors: {
    background: '#F7F5FF',
    surface: '#FFFFFF',
    border: '#E8E4F6',
    borderDetail: '#F0EDFA',
    textPrimary: '#2B2545',
    textSecondary: '#6E6693',
    textMuted: '#A29BC2',
    textStrong: '#4A4270',
    brand: '#7C6FF0',
    primary: '#7C6FF0',
    primaryText: '#5B4FD6',
    primaryBg: '#EEEBFD',
    primaryBgStrong: '#DDD7FB',
    accent: '#FF8A65',
    accentBg: '#FFEFE9',
    backdrop: 'rgba(60,50,100,0.35)',
    headerBg: '#7C6FF0',
    headerTint: '#FFFFFF',
    inputBg: '#EFEDF9',
    inputBorder: 'transparent',
    inputText: '#2B2545',
    placeholder: '#A29BC2',
    surfaceAlt: '#EFEDF9',
  },
  typography: {
    fontFamily: { regular: 'Nunito_400Regular', medium: 'Nunito_600SemiBold', bold: 'Nunito_700Bold', mono: 'monospace' },
    fontSizes: { xs: 10, sm: 11, caption: 12, body2: 13, body: 15, md: 16, base: 16, lg: 19, xl: 23 },
    weights: { regular: '400', medium: '600', semibold: '600', bold: '700' },
    letterSpacing: 0,
  },
  spacing: { xs: 5, sm: 9, md: 14, base: 16, lg: 18, xl: 23, xxl: 28, xxxl: 36 },
  radii: { sm: 14, md: 18, lg: 22, xl: 28, input: 24, button: 26, card: 24, sheet: 32, pill: 999, fab: 28 },
  shadows: {
    card: { elevation: 2, shadowColor: '#7C6FF0', shadowOpacity: 0.1, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } },
    fab: { elevation: 6, shadowColor: '#7C6FF0', shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 5 } },
  },
  motion: {
    duration: { fast: 140, base: 220, slow: 320 },
    easing: Easing.out(Easing.cubic),
    spring: { damping: 15, stiffness: 180 },
    pressFeedback: 'scale',
    enabled: true,
  },
  components: {
    input: { variant: 'filled', height: 48, borderWidth: 0 },
    button: { variant: 'filled', textTransform: 'none', minHeight: 52 },
    sheet: { presentation: 'spring-bottom', showHandle: true, topRadius: 32, maxHeightPct: 88 },
    alert: { presentation: 'spring-pop', buttonLayout: 'stacked', maxWidth: 360 },
    fab: { shape: 'pill', size: 56 },
    card: { borderWidth: 0, divided: false },
    chip: { variant: 'pill' },
  },
  // Roomier: Fluid is the soft, airy skin — give the focused field extra breathing
  // room above the keyboard to match its generous spacing.
  keyboard: { focusExtraOffset: 24 },
});
