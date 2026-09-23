import { FastifyPluginAsync } from 'fastify';
import { overRateLimit } from '../lib/rateLimit';
import { deliver, resolveRoleRecipients } from '../lib/notifications';
import { requirePermission } from '../lib/permissions';

type Pg = { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> };

export interface BroadcastAudience {
  roles?: string[];
  teams?: string[];
  everyone?: boolean;
}

// Resolves a broadcast's target user-id set from an audience spec. `everyone`
// short-circuits to every active user; otherwise the selected roles' members and
// the selected teams' members are unioned. The sender is always excluded (no
// self-notification), and the result is deduped. active-only throughout.
export async function resolveAudience(
  pg: Pg,
  audience: BroadcastAudience,
  senderId: string,
): Promise<string[]> {
  const ids = new Set<string>();
  if (audience.everyone) {
    (await pg.query(`SELECT id FROM users WHERE active = TRUE`, [])).rows.forEach(r => ids.add(r.id as string));
  } else {
    if (audience.roles?.length) {
      (await resolveRoleRecipients(pg, audience.roles)).forEach(i => ids.add(i));
    }
    if (audience.teams?.length) {
      (await pg.query(
        `SELECT DISTINCT tm.user_id FROM team_members tm
           JOIN users u ON u.id = tm.user_id AND u.active = TRUE
          WHERE tm.team_id = ANY($1)`,
        [audience.teams],
      )).rows.forEach(r => ids.add(r.user_id as string));
    }
  }
  ids.delete(senderId);
  return [...ids];
}

// Admin-composed broadcasts. Gated by the `send_notifications` permission and
// per-sender rate-limited (each broadcast fans out to N inbox rows + one push
// batch through deliver()). The body text is the sender's own message — the only
// notification path that carries free-form text (never customer content).
const routes: FastifyPluginAsync = async (fastify) => {
  fastify.post('/broadcast', {
    preHandler: [(fastify as any).authenticate, requirePermission('send_notifications')],
    schema: {
      body: {
        type: 'object',
        required: ['audience', 'title', 'body'],
        properties: {
          audience: { type: 'object' },
          title: { type: 'string', minLength: 1, maxLength: 120 },
          body: { type: 'string', minLength: 1, maxLength: 1000 },
        },
      },
    },
  }, async (request, reply) => {
    const senderId = (request.user as { sub: string }).sub;
    if (overRateLimit(`broadcast:${senderId}`)) return reply.status(429).send({ error: 'rate' });
    const b = request.body as { audience: BroadcastAudience; title: string; body: string };
    const to = await resolveAudience(fastify.pg, b.audience, senderId);
    if (!to.length) return reply.status(400).send({ error: 'empty_audience' });
    await deliver(fastify.pg, to, {
      type: 'broadcast',
      title: b.title,
      body: b.body,
      data: { screen: 'notifications' },
      createdBy: senderId,
    });
    return { ok: true, recipients: to.length };
  });
};
export default routes;
