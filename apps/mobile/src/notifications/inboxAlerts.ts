// #232: pure watermark logic for surfacing newly-synced server inbox rows as
// browser notifications on Expo Web (native gets real Expo push; web's inbox
// otherwise lands silently). DB/React-free for node tests.

export const INBOX_SEEN_KEY = 'alert:inbox_seen';
// A burst (first sync after days offline) surfaces only the newest few —
// browsers throttle notification floods and the inbox screen has the rest.
export const MAX_INBOX_ALERTS = 5;

export interface InboxAlertRow {
  id: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
}

export function evaluateInboxAlerts(
  rows: InboxAlertRow[],
  lastSeenIso: string | null,
): { toNotify: InboxAlertRow[]; nextWatermark: string | null } {
  // Watermark = newest created_at we've considered, read or not — a row read
  // on another device must never re-qualify here.
  let nextWatermark = lastSeenIso;
  for (const r of rows) {
    if (nextWatermark === null || r.created_at > nextWatermark) nextWatermark = r.created_at;
  }
  // First run: seed the watermark silently instead of blasting history.
  if (lastSeenIso === null) return { toNotify: [], nextWatermark };
  const fresh = rows
    .filter(r => r.read_at === null && r.created_at > lastSeenIso)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  return { toNotify: fresh.slice(-MAX_INBOX_ALERTS), nextWatermark };
}
