import { FastifyPluginAsync } from 'fastify';
import { requirePermission, userHasPermission, canActOnTarget } from '../lib/permissions';
import { sanitizeTeamOverrides } from '../lib/syncPolicy';
import { resolveTeamAuthority, managerActionBlocked } from '../lib/teamAuthority';

// Team CRUD and member add/remove used to live here as REST endpoints, but no
// client ever called them — teams, team_members and their permission overrides
// all travel over the generic /sync push/pull path. They were removed
// 2026-08-23 rather than kept hardened; see docs/security/2026-08-09-security-audit.md.
//
// The one endpoint that survives is the member PATCH below: is_manager is
// server-controlled (the sync push ignores client writes to it, since accepting
// them was a self-promotion vector), so promotion/demotion needs a gated online
// round-trip that sync alone cannot provide.

interface MemberPatchBody {
  is_manager?: boolean;
  team_permission_overrides?: Record<string, boolean>;
}

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = [(fastify as any).authenticate];

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
        params: {
          type: 'object', required: ['id', 'uid'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
            uid: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
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

      // Tier guard (security-critical): resolve BOTH the caller's and the target
      // member's current role from the DB and require the caller be at or above
      // the member's tier before ANY change (is_manager promotion or team override
      // edits). Apex full_admin is only touchable by a full_admin. Fails closed on
      // unknown caller/target.
      const guardCallerId = (request.user as { sub: string }).sub;
      const { rows: guardRows } = await fastify.pg.query(
        `SELECT
           (SELECT role FROM users WHERE id = $1) AS caller_role,
           (SELECT role FROM users WHERE id = $2) AS member_role`,
        [guardCallerId, request.params.uid],
      );
      const guardCallerRole = guardRows[0]?.caller_role ?? null;
      const guardMemberRole = guardRows[0]?.member_role ?? null;
      if (!canActOnTarget(guardCallerRole, guardMemberRole)) {
        return reply.status(403).send({ error: 'You cannot manage a team member at or above your own level.' });
      }

      // Toggling is_manager is manager-restricted. /sync/push enforces the same rule
      // via the same resolveTeamAuthority helper — keep both paths on it so neither drifts.
      if (is_manager !== undefined) {
        const authority = await resolveTeamAuthority(fastify.pg, guardCallerId, request.params.id);
        if (managerActionBlocked(authority, 'set_manager')) {
          return reply.status(403).send({ error: 'A team manager cannot change managers on their own team.' });
        }
      }

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
};

export default routes;
