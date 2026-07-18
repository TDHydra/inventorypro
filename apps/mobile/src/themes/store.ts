import { getAppSetting, setAppSetting } from '../db/appSettings';
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
 *   3. DEFAULT_THEME_ID
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
  if (changed) notify();
}

/**
 * Boot-time load, before first render (device DB opens pre-auth). Reads the
 * device cache; the T2 sync layer re-applies the user's synced choice after
 * login/pull via setThemeId(userPrefTheme, { persist: true }).
 */
export function loadThemeFromSettings(): void {
  let id: string | null = null;
  try { id = getAppSetting(THEME_LAST_KEY); } catch { /* DB not ready */ }
  activeTheme = resolveTheme(id);
  // No notify: callers run this before the first render.
}
