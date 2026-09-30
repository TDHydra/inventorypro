// #222: per-field recent-picks list logic for SelectField. Pure — the
// app_settings persistence lives in recentPicksStore.ts so node tests don't
// pull in op-sqlite.

export const RECENT_PICKS_PREFIX = 'recent_picks:';
export const MAX_RECENT_PICKS = 3;

export function pushRecent(prev: string[], id: string, max: number = MAX_RECENT_PICKS): string[] {
  return [id, ...prev.filter(x => x !== id)].slice(0, max);
}

export function parseRecent(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
