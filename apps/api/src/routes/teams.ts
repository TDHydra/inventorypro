import { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../lib/permissions';

interface TeamBody {
  name: string;
  type: string;
}

interface MemberBody {
  user_id: string;
  team_permission_overrides?: Record<string, boolean>;
}

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = [(fastify as any).authenticate];

  // GET /teams — list teams with member counts. Managers are per-member
  // (team_members.is_manager), not a single teams.manager_id — no client reads
  // a manager field off this list today, so it's just dropped rather than
  // replaced with an is_manager aggregate.
  fastify.get('/', { preHandler: auth }, async () => {
    const { rows } = await fastify.pg.query(
      `SELECT t.*, COALESCE(m.cnt, 0) AS member_count
       FROM teams t
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
          },
        },
      },
    },
    async (request) => {
      const { name, type } = request.body;
      const { rows } = await fastify.pg.query(
        `INSERT INTO teams (name, type) VALUES ($1, $2) RETURNING *`,
        [name, type]
      );
      return rows[0];
    }
  );

  // PATCH /teams/:id
  fastify.patch<{ Params: { id: string }; Body: Partial<TeamBody> }>(
    '/:id', { preHandler: [...auth, requirePermission('manage_teams')] },
    async (request, reply) => {
      const { name, type } = request.body;
      const sets: string[] = [];
      const params: unknown[] = [];
      if (name !== undefined) { params.push(name); sets.push(`name = $${params.length}`); }
      if (type !== undefined) { params.push(type); sets.push(`type = $${params.length}`); }
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

  // PATCH /teams/:id/members/:uid — set/clear a member's manager flag. is_manager
  // is server-controlled (sync ignores client writes to it), so this gated
  // endpoint is the ONLY way to promote/demote — closing the self-promotion hole
  // while keeping the feature (and logs.ts scope=my_teams) working.
  fastify.patch<{ Params: { id: string; uid: string }; Body: { is_manager: boolean } }>(
    '/:id/members/:uid', {
      preHandler: [...auth, requirePermission('manage_teams')],
      schema: {
        body: { type: 'object', required: ['is_manager'], properties: { is_manager: { type: 'boolean' } } },
      },
    },
    async (request, reply) => {
      const { rows } = await fastify.pg.query(
        `UPDATE team_members SET is_manager = $3, updated_at = NOW()
         WHERE team_id = $1 AND user_id = $2
         RETURNING team_id, user_id, is_manager`,
        [request.params.id, request.params.uid, request.body.is_manager]
      );
      if (!rows[0]) return reply.status(404).send({ error: 'Member not found' });
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
