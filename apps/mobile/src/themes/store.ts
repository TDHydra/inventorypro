import { getAppSetting, setAppSetting } from '../db/appSettings';
import { getAppConfig, ORG_THEME_KEY } from '../db/appConfig';
import type { Theme } from './types';
import { DEFAULT_THEME_ID, resolveTheme, themes } from './registry';

/**
 * Reactive theme store — same module-cache + version-counter pattern as
 * auth/permissions.ts and db/hiddenFields.ts. useTheme() subscribes via
 * useSyncExternalStore; non-component code (themedAlert, .web forks) reads
 * getTheme() synchronously.
 *
 * Persistence layers (read precedence, see plan):
 *   1. user_prefs.theme  — per-user, synced (wired in by the T2 item)
 *   2. app_settings 'theme_last' — device cache; makes cold boot and the
 *      pre-auth screens (login/unlock/PIN) render the right theme instantly
 *   3. app_config 'default_theme_id' — org-wide default, synced + admin-set
 *      (Phase E, #138); also seeded from the public roster on fresh installs
 *   4. DEFAULT_THEME_ID
 */

const THEME_LAST_KEY = 'theme_last';

let activeTheme: Theme = themes[DEFAULT_THEME_ID];
let version = 0;
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return activeTheme;
}

export function getThemeVersion(): number {
  return version;
}

export function subscribeTheme(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

function notify(): void {
  version++;
  listeners.forEach(l => l());
}

// Web: keep the document's color-scheme (scrollbars, form controls) in step
// with the theme, and cache the dark flag so +html.tsx applies it before
// first paint (no light flash when a dark-theme user reloads).
function applyWebColorScheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.colorScheme = theme.dark ? 'dark' : 'light';
  try { localStorage.setItem('inventorypro_theme_dark', theme.dark ? '1' : '0'); } catch { /* private mode */ }
}

/**
 * Apply a theme by id (unknown ids fall back to default) and cache it on the
 * device. `persist: false` is for sync-driven applies where user_prefs is
 * already the source of truth.
 */
export function setThemeId(id: string, opts: { persist?: boolean } = {}): void {
  const next = resolveTheme(id);
  const changed = next.id !== activeTheme.id;
  activeTheme = next;
  if (opts.persist !== false) {
    try { setAppSetting(THEME_LAST_KEY, next.id); } catch { /* DB not ready — cache next launch */ }
  }
  if (changed) {
    applyWebColorScheme(next);
    notify();
  }
}

/**
 * Boot-time load, before first render (device DB opens pre-auth). Reads the
 * device cache; the T2 sync layer re-applies the user's synced choice after
 * login/pull via setThemeId(userPrefTheme, { persist: true }).
 */
export function loadThemeFromSettings(): void {
  let id: string | null = null;
  try { id = getAppSetting(THEME_LAST_KEY); } catch { /* DB not ready */ }
  // No personal/device choice cached -> org default (synced app_config, also
  // seeded from the public roster on fresh installs) -> built-in default.
  if (!id) id = getAppConfig(ORG_THEME_KEY);
  activeTheme = resolveTheme(id);
  applyWebColorScheme(activeTheme);
  // No notify: callers run this before the first render.
}
