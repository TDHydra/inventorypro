import { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../lib/permissions';

interface TeamBody {
  name: string;
  type: string;
  manager_id?: string | null;
}

interface MemberBody {
  user_id: string;
  team_permission_overrides?: Record<string, boolean>;
}

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = [(fastify as any).authenticate];

  // GET /teams — list teams with member counts
  fastify.get('/', { preHandler: auth }, async () => {
    const { rows } = await fastify.pg.query(
      `SELECT t.*, u.name AS manager_name,
              COALESCE(m.cnt, 0) AS member_count
       FROM teams t
       LEFT JOIN users u ON u.id = t.manager_id
       LEFT JOIN (SELECT team_id, COUNT(*) AS cnt FROM team_members GROUP BY team_id) m
              ON m.team_id = t.id
       ORDER BY t.name`
    );
    return { teams: rows };
  });

  // GET /teams/:id — team detail with roster
  fastify.get<{ Params: { id: string } }>(
    '/:id', { preHandler: auth },
    async (request, reply) => {
      const { id } = request.params;
      const { rows: teamRows } = await fastify.pg.query(
        `SELECT * FROM teams WHERE id = $1`, [id]
      );
      if (!teamRows[0]) return reply.status(404).send({ error: 'Team not found' });
      const { rows: members } = await fastify.pg.query(
        `SELECT tm.user_id, tm.team_permission_overrides, tm.joined_at,
                u.name, u.role
         FROM team_members tm JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1 ORDER BY u.name`,
        [id]
      );
      return { ...teamRows[0], members };
    }
  );

  // POST /teams — create
  fastify.post<{ Body: TeamBody }>(
    '/', {
      preHandler: [...auth, requirePermission('manage_teams')],
      schema: {
        body: {
          type: 'object', required: ['name', 'type'],
          properties: {
            name: { type: 'string', minLength: 1 },
            type: { type: 'string', minLength: 1 },
            manager_id: { type: ['string', 'null'] },
          },
        },
      },
    },
    async (request) => {
      const { name, type, manager_id = null } = request.body;
      const { rows } = await fastify.pg.query(
        `INSERT INTO teams (name, type, manager_id) VALUES ($1, $2, $3) RETURNING *`,
        [name, type, manager_id]
      );
      return rows[0];
    }
  );

  // PATCH /teams/:id
  fastify.patch<{ Params: { id: string }; Body: Partial<TeamBody> }>(
    '/:id', { preHandler: [...auth, requirePermission('manage_teams')] },
    async (request, reply) => {
      const { name, type, manager_id } = request.body;
      const sets: string[] = [];
      const params: unknown[] = [];
      if (name !== undefined) { params.push(name); sets.push(`name = $${params.length}`); }
      if (type !== undefined) { params.push(type); sets.push(`type = $${params.length}`); }
      if (manager_id !== undefined) { params.push(manager_id); sets.push(`manager_id = $${params.length}`); }
      if (sets.length === 0) return reply.status(400).send({ error: 'No fields to update' });
      sets.push(`updated_at = NOW()`);
      params.push(request.params.id);
      const { rows } = await fastify.pg.query(
        `UPDATE teams SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params
      );
      if (!rows[0]) return reply.status(404).send({ error: 'Team not found' });
      return rows[0];
    }
  );

  // POST /teams/:id/members — add a member
  fastify.post<{ Params: { id: string }; Body: MemberBody }>(
    '/:id/members', {
      preHandler: [...auth, requirePermission('manage_teams')],
      schema: {
        body: {
          type: 'object', required: ['user_id'],
          properties: {
            user_id: { type: 'string' },
            team_permission_overrides: { type: 'object' },
          },
        },
      },
    },
    async (request) => {
      const { user_id, team_permission_overrides = {} } = request.body;
      const addedBy = (request.user as { sub: string }).sub;
      const { rows } = await fastify.pg.query(
        `INSERT INTO team_members (team_id, user_id, team_permission_overrides, added_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id, user_id)
         DO UPDATE SET team_permission_overrides = EXCLUDED.team_permission_overrides
         RETURNING *`,
        [request.params.id, user_id, JSON.stringify(team_permission_overrides), addedBy]
      );
      return rows[0];
    }
  );

  // DELETE /teams/:id/members/:uid
  fastify.delete<{ Params: { id: string; uid: string } }>(
    '/:id/members/:uid', { preHandler: [...auth, requirePermission('manage_teams')] },
    async (request) => {
      await fastify.pg.query(
        `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [request.params.id, request.params.uid]
      );
      return { ok: true };
    }
  );
};

export default routes;
