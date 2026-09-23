import { FastifyPluginAsync } from 'fastify';
import { userHasPermission } from '../lib/permissions';
import { loadTableColumns, selectColumnsFor } from '../lib/syncPolicy';
import { teamScopeSql, mediaScopeSql, canSeeAllTeams, resolveCaller } from '../lib/scoping';
import { TEST_ACCOUNT_WRITE_ERROR } from '../lib/testAccounts';
import { overLimit } from '../lib/rateLimit';
import { defaultShareEmailSender, type ShareEmailSender } from '../lib/shareEmail';
import {
  ALLOWED_TABLES,
  FULL_TABLES,
  SCOPED_TABLES,
  MEDIA_SCOPED,
  chatScopeSql,
  manifestPgDrift,
  DELETE_FORBIDDEN_TABLES,
  PRIVILEGED_TABLE_PERM,
} from '../sync/tables';
import { clearTableGuards, runPreAuthorize, runPrivileged, runAuthorizeRow, runAfterApply } from '../sync/registry';
import { registerSyncGuards } from '../sync/guards';
import { applyEntry, ForbiddenColumnsError } from '../sync/apply';
import { checkOperationPermission } from '../sync/opPerm';
import { runPostBatchNotifiers } from '../sync/batch';
import type { BatchState, OutboxEntry, SyncCtx, SyncRejectionCode } from '../sync/types';

// Phase 7 rewrite: this file is a thin skeleton. The table sets derive from
// packages/core's manifest (sync/tables.ts — the same source the mobile client
// derives its contract from), per-table rules live in sync/guards/* (registered
// in the old monolith's evaluation order — rejection precedence is part of the
// wire contract), the generic writer is sync/apply.ts, and post-batch
// notifiers are sync/batch.ts. The wire behavior of /full, /pull and /push is
// unchanged from the old apps/api implementation minus the two tables the
// rebuild dropped (locker_access, dashboard_presets), whose pushes now reject
// at the allowlist and whose pulls are gone.

interface PushBody {
  entries: OutboxEntry[];
}

export interface SyncRoutesOpts {
  // Test seam (the me.ts:51-56 injected-sendCode pattern): production omits
  // this and gets the real SMTP-backed sender; tests inject a stub.
  shareEmailSender?: ShareEmailSender;
  // Manifest-vs-Postgres drift is fatal in production (index.ts sets true):
  // serving a manifest table PG doesn't have would 500 mid-sync. Tests
  // register with partial information_schema stubs, so default is log-only.
  failOnSchemaDrift?: boolean;
}

const routes: FastifyPluginAsync<SyncRoutesOpts> = async (fastify, opts) => {
  const shareEmailSender = opts.shareEmailSender ?? defaultShareEmailSender;
  // The registry is module-global; clear + re-register so a second plugin
  // registration in one process (test files build several instances) never
  // stacks duplicate guards (afterApply hooks would fire twice).
  clearTableGuards();
  registerSyncGuards();
  // Boot-time column introspection — the allowlist of real identifiers per table.
  const realColumns = await loadTableColumns(fastify.pg, [...new Set([...ALLOWED_TABLES, ...FULL_TABLES])]);
  // Drift assertion: every manifest-served table (and its conflict-target +
  // pull columns) must exist in PG. Fatal in production, logged under test
  // stubs (see SyncRoutesOpts.failOnSchemaDrift).
  const drift = manifestPgDrift(realColumns);
  if (drift.length > 0) {
    if (opts.failOnSchemaDrift) {
      throw new Error(`manifest/Postgres drift:\n  ${drift.join('\n  ')}`);
    }
    fastify.log.warn({ drift }, 'manifest/Postgres drift (non-fatal outside production)');
  }

  // GET /sync/full — first-launch paginated full download
  fastify.get<{
    Querystring: { table?: string; page?: string; limit?: string }
  }>('/full', {
    preHandler: [(fastify as any).authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          table: { type: 'string', enum: FULL_TABLES },
          // Coerced + bounded; the handler still parseInt()s and caps limit at 500.
          page: { type: 'integer', minimum: 0, maximum: 1000000 },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
    },
  }, async (request, reply) => {
    const sub = (request.user as { sub?: string })?.sub ?? '';
    // First-launch download pages EVERY full table 500 rows at a time — a real
    // org bursts to dozens/hundreds of requests, and a 429 aborts enrollment.
    if (overLimit('syncfull:' + sub, 300)) return reply.status(429).send({ error: 'rate' });
    const { table, page = '0', limit = '500' } = request.query;
    const pageNum = parseInt(page, 10);
    const limitNum = Math.min(parseInt(limit, 10), 500);
    const offset = pageNum * limitNum;

    if (!table || !FULL_TABLES.includes(table)) {
      return reply.status(400).send({ error: 'Invalid table' });
    }

    const userId = (request.user as { sub?: string })?.sub;
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });
    const caller = await resolveCaller(fastify.pg, userId);
    if (!caller) return reply.status(403).send({ error: 'Unknown user' });
    const canViewFinancial = userHasPermission(caller.role, caller.permission_overrides, 'view_financial_data', caller.role_overrides, caller.team_overrides);
    // #204: view_teams/view_locations — column redaction (locations) + a
    // team_members row carve-out (below), computed identically here and in
    // /sync/pull so full-download and incremental pull never diverge.
    const canViewTeams = userHasPermission(caller.role, caller.permission_overrides, 'view_teams', caller.role_overrides, caller.team_overrides);
    const canViewLocations = userHasPermission(caller.role, caller.permission_overrides, 'view_locations', caller.role_overrides, caller.team_overrides);
    // H5: only manage_users holders receive other employees' email/phone and the
    // full permission_overrides map (selectColumnsFor caller-scopes the rest).
    const canManageUsers = userHasPermission(caller.role, caller.permission_overrides, 'manage_users', caller.role_overrides, caller.team_overrides);

    // Scoping precedence: own-user column → chat membership → media audience →
    // team membership (strategy tags from the manifest, SQL from lib/scoping).
    // NOTE the caller id is $3 here ($1 = limit, $2 = offset) but $2 in /sync/pull.
    const scopeCol = SCOPED_TABLES[table];
    const chatScope = chatScopeSql(table, '$3');
    const mediaScope = MEDIA_SCOPED.has(table) ? mediaScopeSql('$3') : null;
    // #204: a caller lacking view_teams sees only their OWN team_members row(s)
    // — never a teammate's row or team_permission_overrides. This OVERRIDES
    // canSeeAllTeams (an org-authority caller with view_teams explicitly
    // revoked is still restricted to self).
    const teamScope = table === 'team_members' && !canViewTeams
      ? 'user_id = $3'
      : (canSeeAllTeams(caller) ? null : teamScopeSql(table, '$3'));
    const scopeSql = scopeCol ? ` WHERE ${scopeCol} = $3`
      : chatScope ? ` WHERE ${chatScope}`
      : mediaScope ? ` WHERE ${mediaScope}`
      : teamScope ? ` WHERE ${teamScope}` : '';
    const scoped = !!scopeCol || !!chatScope || !!mediaScope || !!teamScope;
    // H5: the users table isn't in any scope set, but a non-privileged caller's
    // projection references the caller id ($3) in its permission_overrides CASE.
    const needsCaller = scoped || (table === 'users' && !canManageUsers);
    const { rows } = await fastify.pg.query(
      `SELECT ${selectColumnsFor(table, canViewFinancial, canViewLocations, { canManageUsers, callerParam: '$3' })} FROM ${table}${scopeSql} ORDER BY 1 LIMIT $1 OFFSET $2`,
      needsCaller ? [limitNum + 1, offset, userId] : [limitNum + 1, offset]
    );

    const hasMore = rows.length > limitNum;
    return { rows: (rows as Record<string, unknown>[]).slice(0, limitNum), hasMore };
  });

  // GET /sync/pull — incremental changes since timestamp
  fastify.get<{
    Querystring: { since?: string }
  }>('/pull', {
    preHandler: [(fastify as any).authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          // ISO timestamp watermark; defaults to epoch when omitted.
          since: { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
    },
  }, async (request, reply) => {
    const sub = (request.user as { sub?: string })?.sub ?? '';
    // 120/min matches the global mutation ceiling — abuse-safe without
    // throttling a busy offline-first client catching up.
    if (overLimit('syncpull:' + sub, 120)) return reply.status(429).send({ error: 'rate' });
    const since = request.query.since ?? new Date(0).toISOString();
    const results: Record<string, { rows: unknown[] }> = {};

    const userId = (request.user as { sub?: string })?.sub;
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });
    const caller = await resolveCaller(fastify.pg, userId);
    if (!caller) return reply.status(403).send({ error: 'Unknown user' });
    const canViewFinancial = userHasPermission(caller.role, caller.permission_overrides, 'view_financial_data', caller.role_overrides, caller.team_overrides);
    // #204: computed identically to /sync/full above.
    const canViewTeams = userHasPermission(caller.role, caller.permission_overrides, 'view_teams', caller.role_overrides, caller.team_overrides);
    const canViewLocations = userHasPermission(caller.role, caller.permission_overrides, 'view_locations', caller.role_overrides, caller.team_overrides);
    const canManageUsers = userHasPermission(caller.role, caller.permission_overrides, 'manage_users', caller.role_overrides, caller.team_overrides);

    for (const table of FULL_TABLES) {
      const dateCol = 'updated_at';
      // Same scoping as /sync/full; NOTE the caller id is $2 here ($1 = since).
      const scopeCol = SCOPED_TABLES[table];
      const chatScope = chatScopeSql(table, '$2');
      const mediaScope = MEDIA_SCOPED.has(table) ? mediaScopeSql('$2') : null;
      const teamScope = table === 'team_members' && !canViewTeams
        ? 'user_id = $2'
        : (canSeeAllTeams(caller) ? null : teamScopeSql(table, '$2'));
      const scopeSql = scopeCol ? ` AND ${scopeCol} = $2`
        : chatScope ? ` AND ${chatScope}`
        : mediaScope ? ` AND ${mediaScope}`
        : teamScope ? ` AND ${teamScope}` : '';
      const scoped = !!scopeCol || !!chatScope || !!mediaScope || !!teamScope;
      const needsCaller = scoped || (table === 'users' && !canManageUsers);
      const { rows } = await fastify.pg.query(
        `SELECT ${selectColumnsFor(table, canViewFinancial, canViewLocations, { canManageUsers, callerParam: '$2' })} FROM ${table} WHERE ${dateCol} > $1${scopeSql}`,
        needsCaller ? [since, userId] : [since]
      );
      results[table] = { rows };
    }

    return results;
  });

  // POST /sync/push — apply device outbox entries
  fastify.post<{ Body: PushBody }>('/push', {
    preHandler: [(fastify as any).authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['entries'],
        properties: {
          entries: { type: 'array', items: { type: 'object' }, maxItems: 100 },
        },
      },
    },
  }, async (request, reply) => {
    const { entries } = request.body;
    const ok: string[] = [];
    const conflicts: Array<{ id: string; error: string; code: SyncRejectionCode }> = [];

    // Resolve the caller's *current* permissions from the DB — not the JWT role
    // claim, which can be stale or forged-stale within the 15m token window.
    const userId = (request.user as { sub?: string })?.sub;
    if (!userId) return reply.status(401).send({ error: 'Unauthorized' });
    const caller = await resolveCaller(fastify.pg, userId);
    if (!caller) return reply.status(403).send({ error: 'Unknown user' });
    const can = (perm: string) =>
      userHasPermission(caller.role, caller.permission_overrides, perm, caller.role_overrides, caller.team_overrides);

    // Server-side maintenance freeze: when on, only admins (system_settings)
    // may write — mirrors the client's assertWritable().
    const { rows: mRows } = await fastify.pg.query(
      `SELECT value FROM app_config WHERE key = 'maintenance_mode'`,
      [],
    );
    const maintenanceOn = !!mRows[0] && (mRows[0] as { value: string }).value === '1';
    const maintenanceExempt = can('system_settings');

    const batch: BatchState = {
      vehicleAlias: new Map(),
      touchedItems: new Set(),
      mediaCleanup: new Map(),
      merged: [],
    };
    const ctx: SyncCtx = {
      pg: fastify.pg,
      userId,
      caller,
      can,
      log: request.log,
      batch,
      flagInjectionAttempt: () => {
        (request as unknown as { auditInjectionAttempt?: boolean }).auditInjectionAttempt = true;
      },
      shareEmailSender,
    };

    for (const entry of entries) {
      // 1. Allowlist (manifest PUSH_TABLES). A write aimed at a table outside
      // it is a crafted payload, not a client typo — flag for the audit trail.
      if (!ALLOWED_TABLES.has(entry.table_name)) {
        ctx.flagInjectionAttempt();
        request.log.warn(
          { userId, table: entry.table_name, operation: entry.operation },
          'sync push entry rejected (table not allowlisted)',
        );
        conflicts.push({ id: entry.id, error: 'Table not allowed', code: 'NOT_ALLOWED' });
        continue;
      }

      // 2. M3: the route schema validates only `entries: array<object>`, never
      // the shape of `payload`. Reject just a malformed entry — VALIDATION is
      // permanent, so the client drops it instead of retrying forever.
      if (entry.payload == null || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) {
        conflicts.push({ id: entry.id, error: 'cannot apply: malformed payload', code: 'VALIDATION' });
        continue;
      }

      // 3. preAuthorize guards (activity_log action gate).
      const pre = await runPreAuthorize(ctx, entry);
      if (pre) { conflicts.push({ id: entry.id, ...pre }); continue; }

      // 4. Test/demo accounts are sandbox-only — ABOVE every other branch
      // (including the system_settings maintenance exemption).
      if (caller.is_test) {
        conflicts.push({ id: entry.id, error: TEST_ACCOUNT_WRITE_ERROR, code: 'FORBIDDEN' });
        continue;
      }

      // 5. Maintenance freeze.
      if (maintenanceOn && !maintenanceExempt) {
        conflicts.push({ id: entry.id, error: 'Maintenance mode: writes are frozen', code: 'MAINTENANCE' });
        continue;
      }

      // 6. Privileged-table authorization — block escalation via crafted rows.
      const reqPerm = PRIVILEGED_TABLE_PERM[entry.table_name];
      if (reqPerm && !can(reqPerm)) {
        request.log.warn(
          { userId, role: caller.role, table: entry.table_name, operation: entry.operation, reqPerm },
          'sync push entry denied (authz)',
        );
        conflicts.push({ id: entry.id, error: `Forbidden: ${entry.table_name} requires ${reqPerm}`, code: 'FORBIDDEN' });
        continue;
      }

      // 7. privileged guards (app_config demo_mode, role_settings tier/grant).
      const priv = await runPrivileged(ctx, entry);
      if (priv) { conflicts.push({ id: entry.id, ...priv }); continue; }

      // 8. Privileged rows are never DELETED via sync: users deactivate
      // (active=false), not delete; roles/config persist.
      if (entry.operation === 'DELETE' && DELETE_FORBIDDEN_TABLES.has(entry.table_name)) {
        conflicts.push({ id: entry.id, error: `Forbidden: ${entry.table_name} cannot be deleted via sync`, code: 'NOT_ALLOWED' });
        continue;
      }

      // 9. Operation-permission gate (ADJUST + locker, carve-outs, generic map).
      const opRej = await checkOperationPermission(ctx, entry);
      if (opRej) { conflicts.push({ id: entry.id, ...opRej }); continue; }

      // 10. authorizeRow guards — per-row authorization, payload
      // normalisation, pre-capture, in registration order (guards/index.ts).
      const rowVerdict = await runAuthorizeRow(ctx, entry);
      if (rowVerdict && 'error' in rowVerdict) {
        conflicts.push({ id: entry.id, ...rowVerdict });
        continue;
      }
      if (rowVerdict && 'handled' in rowVerdict) {
        // Handled without applying (the #129 vehicle-duplicate merge): ok the
        // entry so the client outbox clears; batch.merged carries the remap.
        ok.push(entry.id);
        continue;
      }

      // 11. Apply + afterApply side effects.
      try {
        await applyEntry(fastify.pg, entry, userId, realColumns, can, batch.touchedItems);
        ok.push(entry.id);
        await runAfterApply(ctx, entry);
      } catch (err) {
        // A rejected write of a forbidden/unknown column is a schema-probing
        // signal (not a benign conflict) — flag the request for the audit trail.
        if (err instanceof ForbiddenColumnsError) ctx.flagInjectionAttempt();
        // Log the offending entry so a stuck/rejected outbox row is diagnosable.
        request.log.warn(
          {
            entryId: entry.id,
            table: entry.table_name,
            operation: entry.operation,
            payloadKeys: entry.payload ? Object.keys(entry.payload) : [],
            error: (err as Error).message,
          },
          'sync push entry rejected',
        );
        // A3: never echo the raw DB/error message to the client. FK violation
        // (23503) is a genuine orphan — permanent wording (matches the mobile
        // engine's /forbidden|cannot|not allowed/i drop regex) so the entry
        // dead-letters instead of retry-looping; everything else stays the
        // generic transient wording.
        const isFkViolation = (err as { code?: string }).code === '23503';
        conflicts.push({
          id: entry.id,
          error: isFkViolation ? 'cannot apply: referenced row missing' : 'write rejected',
          code: isFkViolation ? 'VALIDATION' : 'CONFLICT',
        });
      }
    }

    if (conflicts.length > 0) {
      request.log.warn({ count: conflicts.length }, 'sync push had conflicts');
    }

    // Post-batch fire-and-forget notifiers (low-stock, #230 schedule,
    // threshold auto-flag).
    runPostBatchNotifiers(fastify.pg, userId, entries, ok, batch.touchedItems);

    return { ok, conflicts, merged: batch.merged };
  });
};

export default routes;
