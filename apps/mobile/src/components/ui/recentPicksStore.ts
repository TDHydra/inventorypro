import { getAppSetting, setAppSetting } from '../../db/appSettings';
import { RECENT_PICKS_PREFIX, parseRecent, pushRecent } from './recentPicks';

// #222: device-local on purpose (app_settings, not user_prefs) — what one
// person picks often on their phone shouldn't sync to a teammate's.

export function loadRecentPicks(key: string): string[] {
  return parseRecent(getAppSetting(RECENT_PICKS_PREFIX + key));
}

export function saveRecentPick(key: string, id: string): void {
  setAppSetting(RECENT_PICKS_PREFIX + key, JSON.stringify(pushRecent(loadRecentPicks(key), id)));
}
