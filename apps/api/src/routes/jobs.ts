import { FastifyPluginAsync } from 'fastify';
import { requirePermission } from '../lib/permissions';
import { canSeeAllTeams, resolveCaller, teamScopeSql } from '../lib/scoping';

interface JobBody {
  name: string;
  status?: 'open' | 'closed' | 'archived';
  customer_name?: string;
  site_address?: string;
  site_location_id?: string;
  description?: string;
}

interface JobPatchBody {
  name?: string;
  status?: 'open' | 'closed' | 'archived';
  job_number?: string;
  customer_name?: string;
  site_address?: string;
  site_location_id?: string;
  description?: string;
}

const routes: FastifyPluginAsync = async (fastify) => {
  const auth = [(fastify as any).authenticate];

  // GET /jobs?status=open&includeArchived=true — list jobs
  // By default, archived jobs are excluded. Pass ?includeArchived=true to include them.
  fastify.get<{ Querystring: { status?: string; includeArchived?: string } }>(
    '/', {
      preHandler: auth,
      schema: {
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['open', 'closed', 'archived'] },
            includeArchived: { type: 'string', enum: ['true', 'false'] },
          },
        },
      },
    },
    async (request) => {
      const { status, includeArchived } = request.query;
      const userId = (request.user as { sub: string }).sub;
      const params: unknown[] = [];
      const clauses: string[] = [];
      if (status) {
        params.push(status);
        clauses.push(`status = $${params.length}`);
      } else if (includeArchived !== 'true') {
        clauses.push("status != 'archived'");
      }
      // H7 (2026-08-09 audit): mirror the sync pull's team scoping so REST list
      // cannot leak other teams' jobs (customer PII / insurance detail). Org
      // authorities (tier 3+) see everything, same as their sync pull. Fail
      // CLOSED: an unresolvable caller (deleted user, stale token) is scoped like
      // a member of no team, not handed the whole table.
      const caller = await resolveCaller(fastify.pg, userId);
      if (!caller || !canSeeAllTeams(caller)) {
        params.push(userId);
        const scope = teamScopeSql('jobs', `$${params.length}`);
        if (scope) clauses.push(scope);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const { rows } = await fastify.pg.query(
        `SELECT * FROM jobs ${where} ORDER BY updated_at DESC`, params
      );
      return { jobs: rows };
    }
  );

  // GET /jobs/:id — job detail
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
      const userId = (request.user as { sub: string }).sub;
      const params: unknown[] = [request.params.id];
      let scopeClause = '';
      // H7: a non-authority caller may only read a job on one of their teams
      // (or an unassigned/org-wide job) — the same predicate the sync pull uses.
      // A hidden job returns 404, not 403, so ids can't be probed for existence.
      // Fail CLOSED: an unresolvable caller is scoped, never handed every job.
      const caller = await resolveCaller(fastify.pg, userId);
      if (!caller || !canSeeAllTeams(caller)) {
        params.push(userId);
        const scope = teamScopeSql('jobs', `$${params.length}`);
        if (scope) scopeClause = ` AND ${scope}`;
      }
      const { rows } = await fastify.pg.query(
        `SELECT * FROM jobs WHERE id = $1${scopeClause}`, params
      );
      if (!rows[0]) return reply.status(404).send({ error: 'Job not found' });
      return rows[0];
    }
  );

  // POST /jobs — create (job_number is NOT supplied; trigger assigns it)
  fastify.post<{ Body: JobBody }>(
    '/', {
      preHandler: [...auth, requirePermission('create_jobs')],
      schema: {
        body: {
          type: 'object', required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: ['open', 'closed', 'archived'] },
            customer_name: { type: 'string' },
            site_address: { type: 'string' },
            site_location_id: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    },
    async (request) => {
      const { name, status = 'open', customer_name, site_address, site_location_id, description } = request.body;
      const userId = (request.user as { sub: string }).sub;
      const { rows } = await fastify.pg.query(
        `INSERT INTO jobs (name, status, created_by, customer_name, site_address, site_location_id, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [name, status, userId, customer_name ?? null, site_address ?? null, site_location_id ?? null, description ?? null]
      );
      return rows[0];
    }
  );

  // PATCH /jobs/:id — update name/status/job_number/work-order fields
  fastify.patch<{ Params: { id: string }; Body: JobPatchBody }>(
    '/:id', {
      preHandler: [...auth, requirePermission('close_jobs')],
      schema: {
        params: {
          type: 'object', required: ['id'],
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 64 },
          },
        },
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: ['open', 'closed', 'archived'] },
            job_number: { type: 'string' },
            customer_name: { type: 'string' },
            site_address: { type: 'string' },
            site_location_id: { type: 'string' },
            description: { type: 'string' },
          },
        },
      },
    },
    async (request, reply) => {
      const { name, status, job_number, customer_name, site_address, site_location_id, description } = request.body;
      const sets: string[] = [];
      const params: unknown[] = [];
      if (name !== undefined) { params.push(name); sets.push(`name = $${params.length}`); }
      if (status !== undefined) { params.push(status); sets.push(`status = $${params.length}`); }
      if (job_number !== undefined) { params.push(job_number); sets.push(`job_number = $${params.length}`); }
      if (customer_name !== undefined) { params.push(customer_name); sets.push(`customer_name = $${params.length}`); }
      if (site_address !== undefined) { params.push(site_address); sets.push(`site_address = $${params.length}`); }
      if (site_location_id !== undefined) { params.push(site_location_id); sets.push(`site_location_id = $${params.length}`); }
      if (description !== undefined) { params.push(description); sets.push(`description = $${params.length}`); }
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
