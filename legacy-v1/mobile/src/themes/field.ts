import { createTheme } from './createTheme';
import { original } from './original';

/**
 * Field Mode (#211) — legibility-first variant for gloved hands and direct
 * sunlight: bigger touch targets, larger type, thicker/darker borders. Same
 * emerald identity as Original — every value here is a size/contrast lever the
 * kit primitives already read from tokens, not a redesign.
 */
export const field = createTheme(original, {
  id: 'field',
  name: 'Field Mode',
  dark: false,
  colors: {
    // Darker secondary/muted text + stronger borders — Original's slate greys
    // wash out in direct sun.
    textSecondary: '#475569', textMuted: '#64748B',
    border: '#94A3B8', borderDetail: '#CBD5E1',
    inputBorder: '#94A3B8',
  },
  typography: {
    // Original sizes +2 across the scale (xl +4): one legibility step without
    // reflowing dense screens the way the OS-level huge-font setting does.
    fontSizes: { xs: 12, sm: 13, caption: 14, body2: 15, body: 16, md: 17, base: 18, lg: 20, xl: 26 },
  },
  components: {
    input: { variant: 'outlined', height: 56, borderWidth: 2 },
    button: { variant: 'filled', textTransform: 'none', minHeight: 56 },
    fab: { shape: 'circle', size: 64 },
    card: { borderWidth: 2, divided: false },
  },
});
