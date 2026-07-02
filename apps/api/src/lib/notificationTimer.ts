import { getNotifyConfig, claimEvent, dedupKeys, resolveRecipients, deliver } from './notifications';

type Pg = { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> };

async function runCheckoutIdleCheck(pg: Pg, idleMin: number, pollMin: number): Promise<void> {
  // Group each user's checkouts into sessions (new session when the gap from the
  // previous checkout >= idleMin). Emit sessions whose LAST checkout is now idle
  // (>= idleMin ago) but recent enough to be *newly* idle (dedup covers overlap).
  const { rows } = await pg.query(
    `WITH ck AS (
       SELECT user_id, created_at,
              LAG(created_at) OVER (PARTITION BY user_id ORDER BY created_at) AS prev_at
         FROM activity_log
        WHERE action IN ('checkout','checkout_to_job') AND created_at > NOW() - INTERVAL '2 days'
     ),
     sessioned AS (
       SELECT user_id, created_at,
              SUM(CASE WHEN prev_at IS NULL OR created_at - prev_at >= ($1||' min')::interval THEN 1 ELSE 0 END)
                OVER (PARTITION BY user_id ORDER BY created_at) AS session_no
         FROM ck
     )
     SELECT user_id, MAX(created_at) AS last_ts, COUNT(*) AS cnt
       FROM sessioned GROUP BY user_id, session_no
      HAVING MAX(created_at) <  NOW() - ($1||' min')::interval
         AND MAX(created_at) >  NOW() - (($1::int + $2::int * 2)||' min')::interval`,
    [String(idleMin), String(pollMin)]);
  for (const r of rows) {
    const userId = String(r.user_id);
    const lastTs = new Date(r.last_ts).toISOString();
    // Resolve recipients BEFORE claiming the dedup key — otherwise a manager-less
    // crew member's session burns its key with no push sent, and a manager added
    // to the team later would get no retroactive notice.
    const recipients = await resolveRecipients(pg, 'checkout_idle', { userId });
    if (!recipients.length) continue;
    if (!(await claimEvent(pg, dedupKeys.session(userId, lastTs)))) continue;
    const { rows: u } = await pg.query(`SELECT name FROM users WHERE id = $1`, [userId]);
    const who = u[0]?.name ?? 'A team member';
    await deliver(pg, recipients, { type: 'checkout_idle', title: 'Checkout complete', body: `${who} finished checking out — ${r.cnt} item(s).`, data: { screen: 'notifications' } });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let currentPollMin = 0;
export function startNotificationTimer(pg: Pg): void {
  const schedule = (pollMin: number) => {
    if (timer) clearInterval(timer);
    currentPollMin = pollMin;
    timer = setInterval(tick, pollMin * 60_000);
  };
  const tick = async () => {
    try {
      const cfg = await getNotifyConfig(pg);
      if (cfg.pollMin !== currentPollMin) schedule(cfg.pollMin); // apply interval changes live
      if (!cfg.enabled) return;
      await runCheckoutIdleCheck(pg, cfg.idleMin, cfg.pollMin);
    } catch (e) { console.error('[notify] tick failed', e); } // never let the timer die
  };
  schedule(5); // default cadence until first tick reads config
}
