import { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../lib/permissions';

interface LogQuery {
  user_id?: string;
  entity_type?: string;
  entity_id?: string;
  action?: string;
  job_id?: string;
  limit?: string;
  before?: string; // ISO timestamp, exclusive upper bound
  after?: string;  // ISO timestamp, inclusive lower bound
}

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = [
    (fastify as any).authenticate,
    requirePermission('view_all_logs'),
  ];

  // GET /logs — filtered, paginated activity log (read-only; the log is append-only)
  fastify.get<{ Querystring: LogQuery }>(
    '/', { preHandler: auth },
    async (request) => {
      const q = request.query;
      const filters: string[] = [];
      const params: unknown[] = [];

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
