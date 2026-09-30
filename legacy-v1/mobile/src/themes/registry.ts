import type { Theme } from './types';
import { original } from './original';
import { modern } from './modern';
import { classic } from './classic';
import { fluid } from './fluid';
import { futuristic } from './futuristic';
import { field } from './field';

export { createTheme } from './createTheme';

/**
 * Every selectable theme. Adding a theme later = its file (createTheme diffs
 * against original) + one line here. Dev-only themes (Debug) are appended
 * behind __DEV__ so they never appear in release pickers.
 */
export const themes: Record<string, Theme> = {
  original,
  modern,
  classic,
  fluid,
  futuristic,
  field,
};

// Dev-only coverage probe (garish values — unmigrated surfaces scream).
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
