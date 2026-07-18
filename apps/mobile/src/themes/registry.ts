import type { Theme, ThemeOverrides } from './types';
import { original } from './original';

/**
 * Deep-merge a base theme with a partial override. Plain objects merge one
 * level per key-group (the Theme shape is at most two levels deep); functions
 * and primitives replace. New themes should diff against `original` (or any
 * other registered theme) so they only state what's different.
 */
export function createTheme(base: Theme, overrides: ThemeOverrides): Theme {
  const out = { ...base } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const baseVal = (base as unknown as Record<string, unknown>)[key];
    if (isPlainObject(value) && isPlainObject(baseVal)) {
      const merged: Record<string, unknown> = { ...baseVal };
      for (const [k2, v2] of Object.entries(value)) {
        if (v2 === undefined) continue;
        const b2 = baseVal[k2];
        merged[k2] = isPlainObject(v2) && isPlainObject(b2) ? { ...b2, ...v2 } : v2;
      }
      out[key] = merged;
    } else {
      out[key] = value;
    }
  }
  return out as unknown as Theme;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof v !== 'function';
}

/**
 * Every selectable theme. Adding a theme later = its file + one line here.
 * Dev-only themes (Debug) are appended in registerDevThemes() so they never
 * appear in release pickers.
 */
export const themes: Record<string, Theme> = {
  original,
};

// Dev-only coverage probe. Safe circular import: debug.ts only calls the
// hoisted createTheme() above during its module init.
if (__DEV__) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  themes.debug = require('./debug').debug;
}

export const DEFAULT_THEME_ID = 'original';

/** Ordered list for the settings picker. */
export function themeList(): Theme[] {
  return Object.values(themes);
}

/** Unknown/removed ids (old data, dev themes in release) fall back to default. */
export function resolveTheme(id: string | null | undefined): Theme {
  return (id && themes[id]) || themes[DEFAULT_THEME_ID];
}
