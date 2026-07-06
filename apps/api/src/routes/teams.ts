import { FastifyPluginAsync } from 'fastify';
import { requirePermission, userHasPermission } from '../lib/permissions';
import { sanitizeTeamOverrides } from '../lib/syncPolicy';

interface TeamBody {
  name: string;
  type: string;
}

interface MemberBody {
  user_id: string;
  team_permission_overrides?: Record<string, boolean>;
}

interface MemberPatchBody {
  is_manager?: boolean;
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
    '/:id', {
      preHandler: auth,
      schema: {
        params: {
          type: 'object', required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    },
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
      // Dual-write the taxonomy FK (#74): resolve type_id from the label so
      // REST-created teams anchor to the taxonomy id like synced ones do.
      const { rows } = await fastify.pg.query(
        `INSERT INTO teams (name, type, type_id) VALUES ($1, $2,
           (SELECT id FROM taxonomy_types WHERE category = 'team' AND label = $2
            ORDER BY active DESC, sort_order ASC, id ASC LIMIT 1))
         RETURNING *`,
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
    async (request, reply) => {
      const { user_id, team_permission_overrides = {} } = request.body;
      const addedBy = (request.user as { sub: string }).sub;
      // Same server-side allowlist + can't-grant-beyond-own-authority guard as the
      // PATCH path — add-member also accepts overrides, so it must sanitize too
      // (else a manage_teams holder could seed admin keys at insert time).
      const { rows: callerRows } = await fastify.pg.query(
        `SELECT u.role, u.permission_overrides, rs.permission_overrides AS role_overrides
           FROM users u LEFT JOIN role_settings rs ON rs.role = u.role WHERE u.id = $1`,
        [addedBy],
      );
      const caller = callerRows[0] as
        | { role: string; permission_overrides: Record<string, boolean> | null; role_overrides: Record<string, boolean> | null }
        | undefined;
      const can = (perm: string): boolean =>
        !!caller && userHasPermission(caller.role, caller.permission_overrides, perm, caller.role_overrides);
      const { clean, rejected } = sanitizeTeamOverrides(team_permission_overrides, can);
      if (rejected.length) {
        return reply.status(400).send({ error: `Disallowed permission override key(s): ${rejected.join(', ')}` });
      }
      const { rows } = await fastify.pg.query(
        `INSERT INTO team_members (team_id, user_id, team_permission_overrides, added_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (team_id, user_id)
         DO UPDATE SET team_permission_overrides = EXCLUDED.team_permission_overrides
         RETURNING *`,
        [request.params.id, user_id, JSON.stringify(clean), addedBy]
      );
      return rows[0];
    }
  );

  // PATCH /teams/:id/members/:uid — set a member's manager flag and/or their
  // per-team permission overrides. is_manager is server-controlled (sync ignores
  // client writes to it), so this gated endpoint is the ONLY way to promote/
  // demote — closing the self-promotion hole while keeping the feature (and
  // logs.ts scope=my_teams) working. team_permission_overrides is a normal
  // (non-SENSITIVE_DENY) column that CAN also be written via the generic sync
  // outbox, but routing edits through this same manage_teams-gated endpoint gives
  // the admin UI an immediate online round-trip with consistent 403 handling,
  // matching the manager-toggle UX.
  fastify.patch<{ Params: { id: string; uid: string }; Body: MemberPatchBody }>(
    '/:id/members/:uid', {
      preHandler: [...auth, requirePermission('manage_teams')],
      schema: {
        body: {
          type: 'object',
          minProperties: 1,
          properties: {
            is_manager: { type: 'boolean' },
            team_permission_overrides: { type: 'object' },
          },
        },
      },
    },
    async (request, reply) => {
      const { is_manager, team_permission_overrides } = request.body;
      const sets: string[] = [];
      const params: unknown[] = [];
      if (is_manager !== undefined) {
        params.push(is_manager);
        sets.push(`is_manager = $${params.length}`);
      }
      if (team_permission_overrides !== undefined) {
        // Server-side allowlist + can't-grant-beyond-own-authority check: without
        // this, a manage_teams holder could stuff admin keys (manage_users,
        // system_settings, manage_roles_permissions, set_pins, manage_teams) into
        // a member's per-team overrides — the mobile UI only limits the keys it
        // shows, which is advisory, not enforcement. Resolve the CALLER's own
        // permission set from the DB (never trust the JWT role claim) so
        // sanitizeTeamOverrides' `can` check is authoritative.
        const callerId = (request.user as { sub: string }).sub;
        const { rows: callerRows } = await fastify.pg.query(
          `SELECT u.role, u.permission_overrides, rs.permission_overrides AS role_overrides
             FROM users u
             LEFT JOIN role_settings rs ON rs.role = u.role
            WHERE u.id = $1`,
          [callerId],
        );
        const caller = callerRows[0] as
          | { role: string; permission_overrides: Record<string, boolean> | null; role_overrides: Record<string, boolean> | null }
          | undefined;
        const can = (perm: string): boolean =>
          !!caller && userHasPermission(caller.role, caller.permission_overrides, perm, caller.role_overrides);
        const { clean, rejected } = sanitizeTeamOverrides(team_permission_overrides, can);
        if (rejected.length) {
          return reply.status(400).send({
            error: `Disallowed permission override key(s): ${rejected.join(', ')}`,
          });
        }
        params.push(JSON.stringify(clean));
        sets.push(`team_permission_overrides = $${params.length}`);
      }
      sets.push(`updated_at = NOW()`);
      params.push(request.params.id, request.params.uid);
      const { rows } = await fastify.pg.query(
        `UPDATE team_members SET ${sets.join(', ')}
         WHERE team_id = $${params.length - 1} AND user_id = $${params.length}
         RETURNING team_id, user_id, is_manager, team_permission_overrides`,
        params
      );
      if (!rows[0]) return reply.status(404).send({ error: 'Member not found' });
      return rows[0];
    }
  );

  // DELETE /teams/:id/members/:uid
  fastify.delete<{ Params: { id: string; uid: string } }>(
    '/:id/members/:uid', {
      preHandler: [...auth, requirePermission('manage_teams')],
      schema: {
        params: {
          type: 'object', required: ['id', 'uid'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
            uid: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
      },
    },
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
