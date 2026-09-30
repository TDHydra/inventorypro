import { Easing } from 'react-native';
import { createTheme } from './createTheme';
import { original } from './original';

/**
 * "Modern" — contemporary redesign (#114), intended default once vetted.
 * Cooler airy neutrals, deep-teal primary, light header (the immediate
 * "this is different" signal vs Original's dark brand header), larger radii,
 * shadow-carried depth, fade-scale alerts.
 */
export const modern = createTheme(original, {
  id: 'modern',
  name: 'Modern',
  colors: {
    background: '#FAFBFC',
    surface: '#FFFFFF',
    border: '#EAEEF3',
    borderDetail: '#F3F6FA',
    textPrimary: '#0F172A',
    brand: '#0F766E',
    primary: '#0F766E',
    primaryText: '#0B5D57',
    primaryBg: '#E6F2F0',
    primaryBgStrong: '#CCE5E1',
    accentBg: '#FFF3E8',
    onPrimary: '#FFFFFF',
    backdrop: 'rgba(2,6,23,0.5)',
    headerBg: '#FFFFFF',
    headerTint: '#0F172A',
    inputBg: '#FFFFFF',
    inputBorder: '#EAEEF3',
    inputText: '#0F172A',
  },
  typography: {
    weights: { regular: '400', medium: '500', semibold: '600', bold: '600' },
    letterSpacing: -0.2,
  },
  radii: { sm: 10, md: 12, lg: 14, xl: 24, input: 12, button: 12, card: 16, sheet: 24, fab: 28 },
  shadows: {
    card: { elevation: 2, shadowColor: '#0F172A', shadowOpacity: 0.06, shadowRadius: 12, shadowOffset: { width: 0, height: 4 } },
    fab: { elevation: 5, shadowColor: '#0F172A', shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  },
  motion: {
    duration: { fast: 130, base: 180, slow: 260 },
    easing: Easing.out(Easing.quad),
    spring: null,
    pressFeedback: 'opacity',
    enabled: true,
  },
  components: {
    input: { variant: 'outlined', height: 46, borderWidth: 1 },
    button: { variant: 'filled', textTransform: 'none', minHeight: 48 },
    sheet: { presentation: 'slide-bottom', showHandle: true, topRadius: 24, maxHeightPct: 88 },
    alert: { presentation: 'fade-scale', buttonLayout: 'row', maxWidth: 400 },
    fab: { shape: 'circle', size: 56 },
    card: { borderWidth: 0, divided: false },
    chip: { variant: 'pill' },
  },
});
