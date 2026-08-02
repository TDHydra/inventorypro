import { dedupKeys, claimEvent, resolveRecipients, deliver } from './notifications';

// #210: server 5xx-spike canary. The api_request_audit table (migration 042)
// already records every server_error outcome; this polls it and pushes admins
// when errors spike, so a broken deploy or dying dependency surfaces as a
// notification instead of waiting for a user report. Sibling to the audit
// prune timer — same run-now-then-interval + unref pattern.

type Pg = { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> };

export const CANARY_WINDOW_MIN = 15;
export const CANARY_THRESHOLD = 5;
export const CANARY_POLL_MS = 5 * 60_000;

// One alert per UTC hour at most — a sustained outage keeps re-qualifying
// every poll, and per-poll dedup alone would page admins 12×/hour.
export function canaryBucket(now: Date): string {
  return now.toISOString().slice(0, 13);
}

export function shouldAlertCanary(count: number, threshold = CANARY_THRESHOLD): boolean {
  return count >= threshold;
}

export function canaryBody(count: number, windowMin = CANARY_WINDOW_MIN): string {
  const noun = count === 1 ? 'server error' : 'server errors';
  return `${count} ${noun} in the last ${windowMin} min — check the API logs.`;
}

export async function runErrorCanaryCheck(pg: Pg, now = new Date()): Promise<void> {
  const { rows } = await pg.query(
    `SELECT COUNT(*)::int AS n FROM api_request_audit
      WHERE outcome = 'server_error' AND occurred_at > NOW() - ($1 || ' min')::INTERVAL`,
    [String(CANARY_WINDOW_MIN)],
  );
  const n = Number(rows[0]?.n ?? 0);
  if (!shouldAlertCanary(n)) return;

  // Resolve BEFORE claiming the dedup key (the notificationTimer lesson): a
  // recipientless alert would otherwise burn the hour's key with nothing sent.
  const recipients = await resolveRecipients(pg, 'server_errors');
  if (!recipients.length) return;
  if (!(await claimEvent(pg, dedupKeys.canary(canaryBucket(now))))) return;

  await deliver(pg, recipients, {
    type: 'server_error_spike',
    title: 'Server errors spiking',
    body: canaryBody(n),
    data: { screen: 'notifications' },
  });
}

export function startErrorCanaryTimer(pg: Pg): NodeJS.Timeout {
  const run = () => {
    runErrorCanaryCheck(pg).catch(e => console.error('[canary] check failed', e));
  };
  run();
  const t = setInterval(run, CANARY_POLL_MS);
  t.unref();
  return t;
}
