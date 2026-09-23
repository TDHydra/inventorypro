// Window-math helper for per-user quiet hours (#242). Mirrors
// apps/api/src/lib/quietHours.ts verbatim (kept in sync intentionally, same
// as the redact.ts/telemetry.ts allowlist-mirroring convention) — quiet
// hours are enforced independently on both sides: the server gates push
// delivery (notifications.ts's deliver() + the direct chat sendPush in
// routes/sync.ts), the client gates its own local alerts
// (runLocalAlertChecks in localAlerts.ts).
//
// Storage: user_prefs.quiet_hours_start/_end are UTC-minutes-since-midnight
// (0-1439), computed by THIS CLIENT at save time from local wall-clock + the
// device's current UTC offset (see settings.tsx's save site for the full
// tradeoff comment on why — no timezone column exists anywhere in this
// schema, so a user who travels or crosses a DST boundary keeps the OLD
// offset baked into their saved window until they resave the setting).
// NULL/NULL = disabled (the same "never set" convention theme/dashboard_layout
// already use).

/** Minutes since UTC midnight for "now" (or an injected Date, for tests). */
export function utcMinutesNow(d: Date = new Date()): number {
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * True when `nowUtcMin` falls inside the [start, end) quiet-hours window.
 * Either bound null → disabled (always false). Handles windows that cross
 * midnight (start > end, e.g. 22:00 UTC -> 07:00 UTC) by treating the window
 * as "at or after start, OR before end". A zero-width window (start === end)
 * is equivalent to disabled, never "always on".
 */
export function isQuietHoursNow(
  startMin: number | null,
  endMin: number | null,
  nowUtcMin: number,
): boolean {
  if (startMin == null || endMin == null) return false;
  // A zero-width window (start === end) would otherwise fall into the
  // "wraps midnight" branch below and evaluate to true for EVERY nowUtcMin
  // (nowUtcMin >= start || nowUtcMin < start is a tautology) — treat it as
  // disabled instead, matching "start and end are the same instant" intent.
  if (startMin === endMin) return false;
  return startMin < endMin
    ? nowUtcMin >= startMin && nowUtcMin < endMin
    : nowUtcMin >= startMin || nowUtcMin < endMin;
}
