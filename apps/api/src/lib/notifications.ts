// Shared notification core: dedup claim/release, recipient resolution, and the
// admin-configurable durations. Consumed by the write-triggered hooks in
// routes/sync.ts and the in-process timer in notificationTimer.ts. Everything
// that actually sends goes through sendPush (lib/push), which is fire-and-forget.
type Pg = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

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

// Managers (is_manager) of every team the user is on, excluding the user themself.
export async function resolveTeamManagers(pg: Pg, userId: string): Promise<string[]> {
  const { rows } = await pg.query(
    `SELECT DISTINCT tm2.user_id FROM team_members tm
       JOIN team_members tm2 ON tm2.team_id = tm.team_id AND tm2.is_manager = TRUE
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
  const toInt = (v: string | undefined, d: number) => Math.max(1, parseInt(v ?? '', 10) || d);
  return {
    enabled: (m.notify_enabled ?? '1') !== '0',
    pollMin: toInt(m.notify_poll_interval_min, 5),
    idleMin: toInt(m.notify_checkout_idle_min, 15),
  };
}
