import type { Theme, ThemeOverrides } from './types';

/**
 * Deep-merge a base theme with a partial override. Plain objects merge one
 * level per key-group (the Theme shape is at most two levels deep); functions
 * and primitives replace. New themes should diff against `original` (or any
 * other theme) so they only state what's different. Own module (not registry)
 * so theme files never import the registry that imports them.
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
