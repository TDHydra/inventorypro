import { FastifyPluginAsync } from 'fastify';
import { userHasPermission } from '../lib/permissions';
import { overLimit } from '../lib/rateLimit';

interface LogQuery {
  user_id?: string;
  entity_type?: string;
  entity_id?: string;
  action?: string;
  job_id?: string;
  limit?: string;
  before?: string; // ISO timestamp, exclusive upper bound
  after?: string;  // ISO timestamp, inclusive lower bound
  scope?: string;  // 'my_teams' → activity by members of teams the requester manages
}

const routes: FastifyPluginAsync = async (fastify) => {
  // Authenticate only — permission is gated inside the handler so that
  // scope=my_teams can be served to managers who hold view_team_activity
  // (but not view_all_logs). The default scope still requires view_all_logs.
  const auth = [(fastify as any).authenticate];

  // GET /logs — filtered, paginated activity log (read-only; the log is append-only)
  fastify.get<{ Querystring: LogQuery }>(
    '/', {
      preHandler: auth,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            user_id: { type: 'string', maxLength: 64 },
            entity_type: { type: 'string', maxLength: 64 },
            entity_id: { type: 'string', maxLength: 64 },
            action: { type: 'string', maxLength: 64 },
            job_id: { type: 'string', maxLength: 64 },
            // Coerced + bounded; the handler further caps at 500 via Math.min.
            limit: { type: 'integer', minimum: 1, maximum: 500 },
            before: { type: 'string', maxLength: 40 }, // ISO timestamp
            after: { type: 'string', maxLength: 40 },  // ISO timestamp
            scope: { type: 'string', maxLength: 32 },
          },
        },
      },
    },
    async (request, reply) => {
      const userId = (request.user as { sub: string }).sub;
      if (overLimit('logs:' + userId, 60)) return reply.status(429).send({ error: 'rate' });
      const q = request.query;
      const myTeams = q.scope === 'my_teams';

      // Resolve the requester's effective permissions once.
      const { rows: permRows } = await fastify.pg.query(
        `SELECT u.role, u.permission_overrides, rs.permission_overrides AS role_overrides
           FROM users u
           LEFT JOIN role_settings rs ON rs.role = u.role
          WHERE u.id = $1`,
        [userId],
      );
      const u = permRows[0];
      const can = (perm: string) =>
        !!u && userHasPermission(u.role, u.permission_overrides, perm, u.role_overrides);

      // Gate: my_teams allowed with view_team_activity OR view_all_logs;
      // every other scope requires view_all_logs.
      const allowed = myTeams
        ? can('view_team_activity') || can('view_all_logs')
        : can('view_all_logs');
      if (!allowed) {
        return reply.status(403).send({ error: 'Forbidden' });
      }

      const filters: string[] = [];
      const params: unknown[] = [];

      // For scope=my_teams, restrict to the managed-team member set. An empty
      // managed set means there is nothing to show.
      if (myTeams) {
        const { rows: memberRows } = await fastify.pg.query(
          `SELECT DISTINCT tm.user_id
             FROM team_members tm
             JOIN team_members me ON me.team_id = tm.team_id
            WHERE me.user_id = $1 AND me.is_manager = TRUE`,
          [userId],
        );
        const memberIds = memberRows.map((r: { user_id: string }) => r.user_id);
        if (memberIds.length === 0) {
          return { logs: [] };
        }
        params.push(memberIds);
        filters.push(`al.user_id = ANY($${params.length})`);
      }

      const add = (col: string, val: string | undefined) => {
        if (val !== undefined) { params.push(val); filters.push(`al.${col} = $${params.length}`); }
      };
      add('user_id', q.user_id);
      add('entity_type', q.entity_type);
      add('entity_id', q.entity_id);
      add('action', q.action);
      add('job_id', q.job_id);
      if (q.before !== undefined) {
        params.push(q.before);
        filters.push(`al.created_at < $${params.length}`);
      }
      if (q.after !== undefined) {
        params.push(q.after);
        filters.push(`al.created_at >= $${params.length}`);
      }

      const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
      const limit = Math.min(parseInt(q.limit ?? '100', 10) || 100, 500);
      params.push(limit);

      const { rows } = await fastify.pg.query(
        `SELECT al.*,
                u.name  AS user_name,
                i.name  AS item_name,
                j.name  AS job_name,
                fl.name AS from_location_name,
                tl.name AS to_location_name
         FROM activity_log al
         LEFT JOIN users u           ON u.id = al.user_id
         LEFT JOIN inventory_items i ON i.id = al.entity_id AND al.entity_type = 'item'
         LEFT JOIN jobs j            ON j.id = al.job_id
         LEFT JOIN locations fl      ON fl.id = al.from_location_id
         LEFT JOIN locations tl      ON tl.id = al.to_location_id
         ${where}
         ORDER BY al.created_at DESC
         LIMIT $${params.length}`,
        params
      );
      return { logs: rows };
    }
  );
};

export default routes;
