// Shared notification core: dedup claim/release, recipient resolution, and the
// admin-configurable durations. Consumed by the write-triggered hooks in
// routes/sync.ts and the in-process timer in notificationTimer.ts. Everything
// that actually sends goes through sendPush (lib/push), which is fire-and-forget.
import { randomUUID } from 'node:crypto';
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
  approval: (id: string) => `approval:req:${id}`,
  apprDecision: (id: string, status: string) => `approval:dec:${id}:${status}`,
  coverage: (id: string) => `oncall:coverage:${id}`,
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// #87: recipients for a pool photo share. 'users' → the listed ids; 'team' →
// active members of every team the sender is on; 'everyone' → [] (everyone-
// shares are deliberately quiet: media hub + scope SQL carry them, no blast).
// Sender always excluded.
export async function resolvePoolRecipients(
  pg: Pg,
  audience: 'team' | 'users' | 'everyone',
  audienceUserIds: unknown,
  senderId: string,
): Promise<string[]> {
  const ids = new Set<string>();
  if (audience === 'users') {
    const listed: string[] = [];
    try {
      const parsed = JSON.parse(String(audienceUserIds));
      // Only UUID-shaped strings survive: a non-UUID string would make the
      // active-users filter below throw on the uuid cast (id = ANY($1)),
      // zeroing out the whole share's recipients.
      if (Array.isArray(parsed)) parsed.forEach(v => { if (typeof v === 'string' && UUID_RE.test(v)) listed.push(v); });
    } catch { /* malformed → no recipients */ }
    // Filter through active users (mirrors the 'team' branch's u.active join):
    // notifications.user_id has an FK to users(id) and deliver()'s insert loop
    // shares one try/catch, so a single stale/forged-but-well-formed UUID here
    // would abort every remaining inbox insert AND skip sendPush.
    if (listed.length) {
      (await pg.query(
        `SELECT id FROM users WHERE id = ANY($1) AND active = TRUE`, [listed],
      )).rows.forEach(r => ids.add(r.id as string));
    }
  } else if (audience === 'team') {
    (await pg.query(
      `SELECT DISTINCT tm.user_id FROM team_members tm
         JOIN users u ON u.id = tm.user_id AND u.active = TRUE
        WHERE tm.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1)`,
      [senderId],
    )).rows.forEach(r => ids.add(r.user_id as string));
  }
  ids.delete(senderId);
  return [...ids];
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

// The single delivery funnel: writes one durable per-user `notifications` inbox
// row per recipient AND fires sendPush as a nudge. Every notification trigger
// (assignment, low-stock, checkout-idle, broadcast, approvals) routes through
// here so the in-app inbox stays authoritative and push is best-effort. userIds
// are deduped; empty → no-op. Never throws into callers.
export async function deliver(
  pg: Pg,
  userIds: string[],
  p: { type: string; title: string; body: string; data?: Record<string, unknown>; createdBy?: string; push?: boolean },
): Promise<void> {
  try {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (!ids.length) return;
    const dataJson = p.data ? JSON.stringify(p.data) : null;
    for (const uid of ids) {
      await pg.query(
        `INSERT INTO notifications (id, user_id, type, title, body, data, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [randomUUID(), uid, p.type, p.title, p.body, dataJson, p.createdBy ?? null]);
    }
    // #87: inbox-only channels (e.g. an 'everyone' pool share) pass push:false —
    // the inbox row above still lands, only the device push nudge is skipped.
    if (p.push !== false) await sendPush(pg, ids, { title: p.title, body: p.body, data: p.data });
  } catch { /* never disrupt callers */ }
}

// Recipient-resolution context: the primary subject (userId — e.g. the assignee
// or requester) and, where relevant, the acting caller (actorId) used to gate a
// channel against fan-out to unrelated users.
type RecipientCtx = { userId?: string; actorId?: string };

// Do `actorId` and `otherId` share at least one team? Gates the assignment
// channel: without it, any caller who can UPDATE a repair could aim a
// notification at an ARBITRARY user id. Returns false when either is teamless.
export async function sharesTeam(pg: Pg, actorId: string, otherId: string): Promise<boolean> {
  const { rows } = await pg.query(
    `SELECT 1 FROM team_members a
       JOIN team_members b ON b.team_id = a.team_id
      WHERE a.user_id = $1 AND b.user_id = $2 LIMIT 1`,
    [actorId, otherId]);
  return rows.length > 0;
}

// Per-channel intrinsic recipients — the recipients a channel always notifies
// regardless of admin routing config (e.g. the assignee themself, the manager
// roles for low-stock). Admin-configured routes (notify_route_<channel>) are
// unioned on top by resolveRecipients.
const INTRINSIC: Record<string, (pg: Pg, ctx: RecipientCtx) => Promise<string[]>> = {
  assignment:    async (pg, ctx) => {
    if (!ctx.userId) return [];
    // The assignee must be reachable by the actor (they share a team) before we
    // notify — self-assignment is always allowed, and a missing actor (system
    // trigger) falls back to the assignee alone. This closes the arbitrary-user
    // spam via a crafted repair UPDATE.
    if (ctx.actorId != null && ctx.actorId !== ctx.userId && !(await sharesTeam(pg, ctx.actorId, ctx.userId))) return [];
    return [ctx.userId];
  },
  low_stock:     async (pg) => resolveRoleRecipients(pg, ['full_admin', 'franchise_manager']),
  checkout_idle: async (pg, ctx) => ctx.userId ? resolveTeamManagers(pg, ctx.userId) : [],
  approvals:     async (pg, ctx) => ctx.userId ? resolveTeamManagers(pg, ctx.userId) : [],
  // Coverage saves concern the PM bench: every other active production_manager
  // (the actor already knows — they wrote it). notify_route_on_call unions on top.
  on_call:       async (pg, ctx) => {
    const pms = await resolveRoleRecipients(pg, ['production_manager']);
    return ctx.actorId ? pms.filter(id => id !== ctx.actorId) : pms;
  },
};

// Merges a channel's intrinsic recipients with the admin-configured routing rule
// stored in app_config as `notify_route_<channel>` JSON ({roles,teams,users}).
// Bad/missing config → intrinsic recipients only. Result is deduped + active-only
// (each source already filters u.active). Approvals fall back to org managers
// when neither an intrinsic team manager nor a configured route exists.
export async function resolveRecipients(
  pg: Pg,
  channel: keyof typeof INTRINSIC,
  ctx: RecipientCtx = {},
): Promise<string[]> {
  const intrinsic = await INTRINSIC[channel](pg, ctx);
  let configured: string[] = [];
  try {
    const { rows } = await pg.query(`SELECT value FROM app_config WHERE key = $1`, [`notify_route_${channel}`]);
    const raw = rows[0]?.value as string | undefined;
    if (raw) {
      const cfg = JSON.parse(raw) as { roles?: string[]; teams?: string[]; users?: string[] };
      const fromRoles = cfg.roles?.length ? await resolveRoleRecipients(pg, cfg.roles) : [];
      const fromTeams = cfg.teams?.length
        ? (await pg.query(`SELECT DISTINCT tm.user_id FROM team_members tm JOIN users u ON u.id = tm.user_id AND u.active = TRUE WHERE tm.team_id = ANY($1)`, [cfg.teams])).rows.map(r => r.user_id as string)
        : [];
      configured = [...fromRoles, ...fromTeams, ...(cfg.users ?? [])];
    }
  } catch { /* bad config → intrinsic only */ }
  // approvals: approver defaults, fall back to org managers when the requester has no team manager.
  if (channel === 'approvals' && intrinsic.length === 0 && configured.length === 0) {
    configured = await resolveRoleRecipients(pg, ['full_admin', 'franchise_manager']);
  }
  const union = [...new Set([...intrinsic, ...configured])].filter(Boolean);
  if (!union.length) return [];
  // Final active-only pass over the whole set: role/team sources already filter on
  // u.active, but configured `users` (literal ids) and the intrinsic assignment
  // recipient (ctx.userId) are not — a deactivated user routed here or a deactivated
  // assignee would otherwise still receive inbox rows + push. One query guarantees
  // the active-only contract for every source.
  try {
    // NOT is_test: demo accounts never receive notifications — their inbox rows
    // would be server writes for throwaway sessions (and they hold no push token).
    const { rows } = await pg.query(`SELECT id FROM users WHERE id = ANY($1) AND active = TRUE AND NOT is_test`, [union]);
    const active = new Set(rows.map(r => r.id as string));
    return union.filter(u => active.has(u));
  } catch {
    return union; // never fail recipient resolution over an active-filter hiccup
  }
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
        const to = await resolveRecipients(pg, 'low_stock');
        if (to.length) {
          await deliver(pg, to, { type: 'low_stock', title: 'Low stock', body: `${it.name} is at or below its alert level.`, data: { screen: 'inventory', id: itemId } });
        }
      }
    } else {
      await releaseEvent(pg, key); // back above threshold → re-arm
    }
  } catch { /* never disrupt sync */ }
}
