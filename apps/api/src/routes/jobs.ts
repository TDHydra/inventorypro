import { FastifyPluginAsync } from 'fastify';

interface JobBody {
  name: string;
  status?: 'open' | 'closed' | 'archived';
}

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = [(fastify as any).authenticate];

  // GET /jobs?status=open&includeArchived=true — list jobs
  // By default, archived jobs are excluded. Pass ?includeArchived=true to include them.
  fastify.get<{ Querystring: { status?: string; includeArchived?: string } }>(
    '/', { preHandler: auth },
    async (request) => {
      const { status, includeArchived } = request.query;
      const params: unknown[] = [];
      let where = '';
      if (status) {
        where = 'WHERE status = $1';
        params.push(status);
      } else if (includeArchived !== 'true') {
        where = "WHERE status != 'archived'";
      }
      const { rows } = await fastify.pg.query(
        `SELECT * FROM jobs ${where} ORDER BY updated_at DESC`, params
      );
      return { jobs: rows };
    }
  );

  // GET /jobs/:id — job detail
  fastify.get<{ Params: { id: string } }>(
    '/:id', { preHandler: auth },
    async (request, reply) => {
      const { rows } = await fastify.pg.query(
        `SELECT * FROM jobs WHERE id = $1`, [request.params.id]
      );
      if (!rows[0]) return reply.status(404).send({ error: 'Job not found' });
      return rows[0];
    }
  );

  // POST /jobs — create
  fastify.post<{ Body: JobBody }>(
    '/', {
      preHandler: auth,
      schema: {
        body: {
          type: 'object', required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: ['open', 'closed', 'archived'] },
          },
        },
      },
    },
    async (request) => {
      const { name, status = 'open' } = request.body;
      const userId = (request.user as { sub: string }).sub;
      const { rows } = await fastify.pg.query(
        `INSERT INTO jobs (name, status, created_by) VALUES ($1, $2, $3) RETURNING *`,
        [name, status, userId]
      );
      return rows[0];
    }
  );

  // PATCH /jobs/:id — update name/status
  fastify.patch<{ Params: { id: string }; Body: Partial<JobBody> }>(
    '/:id', { preHandler: auth },
    async (request, reply) => {
      const { name, status } = request.body;
      const sets: string[] = [];
      const params: unknown[] = [];
      if (name !== undefined) { params.push(name); sets.push(`name = $${params.length}`); }
      if (status !== undefined) { params.push(status); sets.push(`status = $${params.length}`); }
      if (sets.length === 0) return reply.status(400).send({ error: 'No fields to update' });
      sets.push(`updated_at = NOW()`);
      params.push(request.params.id);
      const { rows } = await fastify.pg.query(
        `UPDATE jobs SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params
      );
      if (!rows[0]) return reply.status(404).send({ error: 'Job not found' });
      return rows[0];
    }
  );
};

export default routes;
