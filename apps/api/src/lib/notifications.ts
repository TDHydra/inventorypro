// Shared notification core: dedup claim/release, recipient resolution, and the
// admin-configurable durations. Consumed by the write-triggered hooks in
// routes/sync.ts and the in-process timer in notificationTimer.ts. Everything
// that actually sends goes through sendPush (lib/push), which is fire-and-forget.
import { sendPush } from './push';

type Pg = { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> };

// Admin-configurable durations are clamped to [1, 1440] minutes. The upper bound
// matters: without it, a large notify_poll_interval_min overflows setInterval's
// 32-bit delay (→ a ~1ms tight loop), and a notify_checkout_idle_min > 24h makes
// the timer's session query (which scans a bounded recent window) permanently
// unsatisfiable. 1440 min (24h) is well beyond any sane value for either.
const MAX_MIN = 1440;

export const dedupKeys = {
  assign: (repairId: string, assignee: string) => `assign:repair:${repairId}:${assignee}`,
  lowstock: (itemId: string) => `lowstock:item:${itemId}`,
  session: (userId: string, lastTs: string) => `session:user:${userId}:${lastTs}`,
};

// Returns true only if this key was newly inserted (i.e. the caller "won" the
// right to notify). A retry / concurrent tick finds the row present → false.
export async function claimEvent(pg: Pg, key: string): Promise<boolean> {
  const { rows } = await pg.query(
    `INSERT INTO notification_dedup (event_key) VALUES ($1)
     ON CONFLICT (event_key) DO NOTHING RETURNING event_key`, [key]);
  return rows.length > 0;
}
export async function releaseEvent(pg: Pg, key: string): Promise<void> {
  await pg.query(`DELETE FROM notification_dedup WHERE event_key = $1`, [key]);
}

// Managers (is_manager) of every team the user is on, excluding the user themself
// and any deactivated manager (mirrors resolveRoleRecipients' active filter).
export async function resolveTeamManagers(pg: Pg, userId: string): Promise<string[]> {
  const { rows } = await pg.query(
    `SELECT DISTINCT tm2.user_id FROM team_members tm
       JOIN team_members tm2 ON tm2.team_id = tm.team_id AND tm2.is_manager = TRUE
       JOIN users u ON u.id = tm2.user_id AND u.active = TRUE
      WHERE tm.user_id = $1 AND tm2.user_id <> $1`, [userId]);
  return rows.map(r => r.user_id as string);
}
export async function resolveRoleRecipients(pg: Pg, roles: string[]): Promise<string[]> {
  const { rows } = await pg.query(
    `SELECT id FROM users WHERE role = ANY($1) AND active = TRUE`, [roles]);
  return rows.map(r => r.id as string);
}

export async function getNotifyConfig(pg: Pg): Promise<{ enabled: boolean; pollMin: number; idleMin: number }> {
  const { rows } = await pg.query(
    `SELECT key, value FROM app_config WHERE key = ANY($1)`,
    [['notify_enabled', 'notify_poll_interval_min', 'notify_checkout_idle_min']]);
  const m: Record<string, string> = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const toInt = (v: string | undefined, d: number) => Math.min(MAX_MIN, Math.max(1, parseInt(v ?? '', 10) || d));
  return {
    enabled: (m.notify_enabled ?? '1') !== '0',
    pollMin: toInt(m.notify_poll_interval_min, 5),
    idleMin: toInt(m.notify_checkout_idle_min, 15),
  };
}

// Re-checks one item's total on-hand vs its min_qty_alert and, deduped, notifies
// the manager roles when at/below threshold — re-arming (releasing the key) once
// it's back above. Designed to run ONCE per touched item AFTER a /sync/push batch
// has fully committed: that avoids both the positive-delta re-arm gap (restocks
// send +delta) and the transfer race (a -qty source leg reading a transient low
// total before its paired +qty dest leg lands). Never throws into the caller.
export async function notifyLowStock(pg: Pg, itemId: string): Promise<void> {
  try {
    const { rows } = await pg.query(
      `SELECT i.name, i.min_qty_alert,
              COALESCE((SELECT SUM(quantity) FROM stock_by_location WHERE item_id = i.id), 0) AS on_hand
         FROM inventory_items i WHERE i.id = $1`, [itemId]);
    const it = rows[0] as { name: string; min_qty_alert: number; on_hand: number } | undefined;
    if (!it) return;
    const key = dedupKeys.lowstock(itemId);
    if (Number(it.on_hand) <= Number(it.min_qty_alert)) {
      if (await claimEvent(pg, key)) {
        const to = await resolveRoleRecipients(pg, ['full_admin', 'franchise_manager']);
        if (to.length) {
          await sendPush(pg, to, { title: 'Low stock', body: `${it.name} is at or below its alert level.`, data: { screen: 'inventory', itemId } });
        }
      }
    } else {
      await releaseEvent(pg, key); // back above threshold → re-arm
    }
  } catch { /* never disrupt sync */ }
}
