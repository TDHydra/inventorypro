import { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../lib/permissions';

interface CreateLocationBody {
  name: string;
  parent_id?: string;
  color?: string;
  icon?: string;
}

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = { preHandler: [(fastify as any).authenticate] };

  // GET /locations — full tree
  fastify.get('/', auth, async () => {
    const { rows } = await fastify.pg.query(
      `SELECT l.*, p.name as parent_name
       FROM locations l
       LEFT JOIN locations p ON p.id = l.parent_id
       ORDER BY l.parent_id NULLS FIRST, l.name ASC`
    );
    return { locations: rows };
  });

  // GET /locations/:id — with stock summary
  fastify.get<{ Params: { id: string } }>('/:id', auth, async (request, reply) => {
    const { rows } = await fastify.pg.query(
      `SELECT l.*,
              json_agg(json_build_object(
                'item_id', s.item_id,
                'item_name', i.name,
                'quantity', s.quantity,
                'unit', i.unit
              ) ORDER BY i.name) as stock
       FROM locations l
       LEFT JOIN stock_by_location s ON s.location_id = l.id
       LEFT JOIN inventory_items i ON i.id = s.item_id
       WHERE l.id = $1
       GROUP BY l.id`,
      [request.params.id]
    );
    if (!rows[0]) return reply.status(404).send({ error: 'Not found' });
    return rows[0];
  });

  // POST /locations
  fastify.post<{ Body: CreateLocationBody }>('/', {
    preHandler: [(fastify as any).authenticate, requirePermission('manage_locations')],
  }, async (request, reply) => {
    const { name, parent_id, color, icon } = request.body;
    const { rows } = await fastify.pg.query(
      `INSERT INTO locations (name, parent_id, color, icon)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, parent_id ?? null, color ?? null, icon ?? null]
    );
    return reply.status(201).send(rows[0]);
  });

  // PATCH /locations/:id
  fastify.patch<{ Params: { id: string }; Body: Partial<CreateLocationBody> }>(
    '/:id', { preHandler: [(fastify as any).authenticate, requirePermission('manage_locations')] },
    async (request, reply) => {
      const allowed = ['name', 'parent_id', 'color', 'icon'];
      const entries = Object.entries(request.body).filter(([k]) => allowed.includes(k));
      if (entries.length === 0) return reply.status(400).send({ error: 'No valid fields' });

      const updates = entries.map(([k], i) => `${k} = $${i + 2}`).join(', ');
      const values = entries.map(([, v]) => v);

      const { rows } = await fastify.pg.query(
        `UPDATE locations SET ${updates}, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [request.params.id, ...values]
      );
      if (!rows[0]) return reply.status(404).send({ error: 'Not found' });
      return rows[0];
    }
  );
};

export default routes;
