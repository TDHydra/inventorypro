# Security Audit Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the CRITICAL/HIGH/MEDIUM/LOW findings from the 2026-07-01 security audit — chiefly the `/sync/push` column-identifier SQL injection + mass-assignment, the unauthenticated first-login account takeover, the operational-authorization gap, sync over-share, and the media/config/client hardening items.

**Architecture:** The exploitable core is the generic `/sync/push` upsert that trusts client-supplied column *names* and writes arbitrary columns. We fix it with a **default-deny sync write policy**: (1) at boot the sync plugin introspects each allowed table's real columns from `information_schema` — any payload key that is not a real column is dropped, so no client string can ever reach SQL as an identifier (kills injection); (2) a per-table **SENSITIVE_DENY** set blocks writes to privilege/credential columns even when they are real (kills mass-assignment); (3) an **OPERATION_PERM** map gates every operational table+operation on the caller's DB-resolved permission (closes the authz gap); (4) reads are column-projected so PII/financial data and `app_config` don't leak to low-tier tokens. Auth gets a one-time enrollment code on `/auth/set-pin`. Media stops trusting client URLs, config fails closed and stops leaking internals, and the web/client hardening items are applied. Work is split into **one short prerequisite track then four file-disjoint tracks that run in parallel**.

**Tech Stack:** Fastify + `@fastify/postgres` (node-postgres, parameterized/extended protocol) + `@fastify/jwt`; Postgres; Expo SDK 56 / op-sqlite (mobile) + sql.js (web). Tests: Node built-in `node:test` + `node:assert/strict` (zero new deps) for pure logic; `curl` smoke checks for wired endpoints.

## Global Constraints

- **No new runtime dependency except `@fastify/helmet`** (installed once in Track 0). `node:test` is built in — do not add vitest/jest.
- **pnpm only.** Dependency/lockfile changes happen ONLY in Track 0 to avoid lockfile merge conflicts across parallel tracks.
- **All SQL stays parameterized for values.** Identifiers may only be interpolated when they come from a server-defined constant OR from the boot-introspected real-column set — never from a raw client key.
- **Never send `pin_hash` or `enrollment_code_hash` to a device** (not in any `SELECT_COLUMNS`, roster, or token response).
- **DB-resolved permissions only** — authorize on `users.role` + `permission_overrides` + `role_settings.permission_overrides` via `userHasPermission`, never on the JWT `role` claim.
- **Migration numbering:** API next = **026**. No mobile migration is needed (enrollment code is server-only; it never syncs).
- **Fail closed:** an operational table+operation with no explicit permission mapping is REJECTED, not allowed.
- Match existing code style in each file (2-space indent, existing comment density).

## Parallelization Map

**File ownership is disjoint per track**, so Tracks A–D run concurrently after Track 0.

| Track | Owns (only these files) | Findings |
|---|---|---|
| **0. Prereqs** (serial, first) | `apps/api/package.json`, `pnpm-lock.yaml`, `apps/api/src/test/helpers.ts` (new) | test harness + helmet dep |
| **A. Sync authz & injection** | `apps/api/src/lib/syncPolicy.ts` (new), `apps/api/src/lib/syncPolicy.test.ts` (new), `apps/api/src/routes/sync.ts` | C1, C2, H1, M1, M5, L3 |
| **B. Auth hardening** | `apps/api/src/routes/auth.ts`, `apps/api/src/routes/users.ts`, `apps/api/src/db/migrations/026_enrollment_code.sql` (new), `apps/api/src/lib/auth-lockout.test.ts` (new) | C3, L1, L2, L5 |
| **C. Media & config** | `apps/api/src/routes/media.ts`, `apps/api/src/index.ts` | M2, M3, M4, L4, L6 |
| **D. Client hardening** | `apps/mobile/src/auth/session.web.ts`, `apps/mobile/src/auth/pin.ts`, `apps/mobile/src/components/MapDisplay.tsx`, `apps/mobile/src/components/MapPickerModal.tsx`, `apps/mobile/app/(auth)/first-launch.tsx` (+ set-pin call site) | M7, L7, L8, L9, C3-mobile |

**Cross-track dependency (only one):** Track **D's** enrollment-code onboarding step (D5) consumes the `/auth/set-pin` contract defined in Track **B** (B2). D1–D4 are independent and can start immediately; D5 is written against the contract in B2's "Produces" block and merged after B lands. Everything else is fully independent.

**Integration** (after all tracks): deploy migration 026, run the prod smoke script, rebuild/hotload the app.

---

## Track 0 — Prerequisites (serial, do first)

### Task 0: Test harness + helmet dependency

**Files:**
- Modify: `apps/api/package.json` (scripts + dependencies)
- Create: `apps/api/src/test/helpers.ts`

**Interfaces:**
- Produces: `npm test` runs `node --test` over `src/**/*.test.ts` via tsx; helper `expectThrows(fn): string` returns the thrown message.

- [ ] **Step 1: Add the test script + helmet dep**

In `apps/api/package.json`, add to `scripts`:
```json
"test": "node --import tsx --test src/**/*.test.ts"
```
Then install helmet (pnpm, from repo root so the lockfile updates once):
```bash
cd /home/tdpotato/inventorypro && pnpm --filter api add @fastify/helmet
```

- [ ] **Step 2: Create the test helper**

`apps/api/src/test/helpers.ts`:
```ts
// Returns the message of the error thrown by fn(), or throws if nothing was thrown.
export function expectThrows(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected fn to throw, but it did not');
}
```

- [ ] **Step 3: Verify the runner works**

Create a throwaway `apps/api/src/test/smoke.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
test('runner works', () => { assert.equal(1 + 1, 2); });
```
Run: `cd apps/api && npm test`
Expected: `# pass 1`. Then delete `src/test/smoke.test.ts`.

- [ ] **Step 4: Commit**
```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/test/helpers.ts
git commit -m "test(api): add node:test harness + @fastify/helmet dep"
```

---

## Track A — Sync authorization & injection hardening

All logic lives in a new **pure** module `syncPolicy.ts` (unit-tested) and is wired into `sync.ts`. Do tasks A1→A5 in order (same files).

### Task A1: Real-column filter (kills C1 — identifier SQL injection)

**Files:**
- Create: `apps/api/src/lib/syncPolicy.ts`
- Create: `apps/api/src/lib/syncPolicy.test.ts`
- Modify: `apps/api/src/routes/sync.ts`

**Interfaces:**
- Produces:
  - `loadTableColumns(pg, tables: string[]): Promise<Map<string, Set<string>>>` — introspects `information_schema.columns`.
  - `keepRealColumns(table, payload, realColumns): { kept: Record<string, unknown>; dropped: string[] }` — pure; drops any key not a real column of `table`.

- [ ] **Step 1: Write the failing test**

`apps/api/src/lib/syncPolicy.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepRealColumns } from './syncPolicy';

const real = new Map([['jobs', new Set(['id', 'name', 'status'])]]);

test('keepRealColumns drops injection-style keys not matching a real column', () => {
  const payload = {
    id: 'x',
    name: 'ok',
    "name = (SELECT pin_hash FROM users LIMIT 1)--": 'evil',
  };
  const { kept, dropped } = keepRealColumns('jobs', payload, real);
  assert.deepEqual(Object.keys(kept), ['id', 'name']);
  assert.deepEqual(dropped, ["name = (SELECT pin_hash FROM users LIMIT 1)--"]);
});

test('keepRealColumns drops everything for an unknown table (fail closed)', () => {
  const { kept } = keepRealColumns('not_a_table', { id: 'x' }, real);
  assert.deepEqual(kept, {});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npm test`
Expected: FAIL — `Cannot find module './syncPolicy'`.

- [ ] **Step 3: Implement `syncPolicy.ts` (this task's part)**

`apps/api/src/lib/syncPolicy.ts`:
```ts
// Pure, unit-tested sync write/read policy. The ONLY place client payload keys are
// vetted before they reach generic SQL. Design: default-deny.

type Pg = { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> };

// Introspect the real columns of each allowed table once at boot. Any client
// payload key not present here is dropped, so no client string can ever be
// interpolated into SQL as an identifier (kills column-identifier injection).
export async function loadTableColumns(pg: Pg, tables: string[]): Promise<Map<string, Set<string>>> {
  const { rows } = await pg.query(
    `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [tables],
  );
  const map = new Map<string, Set<string>>();
  for (const r of rows as { table_name: string; column_name: string }[]) {
    if (!map.has(r.table_name)) map.set(r.table_name, new Set());
    map.get(r.table_name)!.add(r.column_name);
  }
  return map;
}

// Drop any key that is not a real column of `table` (fail closed for unknown table).
export function keepRealColumns(
  table: string,
  payload: Record<string, unknown>,
  realColumns: Map<string, Set<string>>,
): { kept: Record<string, unknown>; dropped: string[] } {
  const cols = realColumns.get(table) ?? new Set<string>();
  const kept: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(payload)) {
    if (cols.has(k)) kept[k] = v;
    else dropped.push(k);
  }
  return { kept, dropped };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npm test`
Expected: PASS (both `keepRealColumns` tests).

- [ ] **Step 5: Wire boot-introspection into `sync.ts`**

In `apps/api/src/routes/sync.ts`, import at top:
```ts
import { loadTableColumns, keepRealColumns } from '../lib/syncPolicy';
```
Inside `const routes: FastifyPluginAsync = async (fastify) => {`, BEFORE the route registrations, add:
```ts
  // Boot-time column introspection — the allowlist of real identifiers per table.
  const realColumns = await loadTableColumns(fastify.pg, [...ALLOWED_TABLES]);
```
Then in `applyEntry`, change its signature to accept the map and apply the filter at the very start of the UPDATE and INSERT branches. Update the call site (line ~349) to `await applyEntry(fastify.pg, entry, userId, realColumns);` and the function signature to include `realColumns: Map<string, Set<string>>`. In the UPDATE branch, after `const sp = sanitizePayload(...)`, replace the raw `Object.keys(sp)` usage with:
```ts
    const { kept, dropped } = keepRealColumns(table_name, sp, realColumns);
    if (dropped.length) request.log?.warn?.({ table: table_name, dropped }, 'sync: dropped non-column keys');
    const cols = Object.keys(kept).filter(k => !keys.includes(k));
```
(Use `kept` for both `setClause` values and the param array.) Apply the same `keepRealColumns` filtering to the INSERT branch's `allKeys` derivation. `request.log` isn't in scope inside `applyEntry`; drop the log there or pass a logger — keep it simple: omit the warn inside `applyEntry` (the push handler already logs rejections).

- [ ] **Step 6: Typecheck + commit**

Run: `cd apps/api && npx tsc --noEmit` → exit 0.
```bash
git add apps/api/src/lib/syncPolicy.ts apps/api/src/lib/syncPolicy.test.ts apps/api/src/routes/sync.ts
git commit -m "fix(sync): drop non-column payload keys via boot-introspected allowlist (SQLi C1)"
```

### Task A2: Sensitive-column deny + attribution move (kills C2 — mass assignment)

**Files:**
- Modify: `apps/api/src/lib/syncPolicy.ts`, `apps/api/src/lib/syncPolicy.test.ts`, `apps/api/src/routes/sync.ts`

**Interfaces:**
- Consumes: `keepRealColumns` (A1).
- Produces: `applyWritePolicy(table, op, payload, callerUserId, realColumns): { row: Record<string, unknown>; rejected: string[] }` — filters to real columns, forces/drops attribution, and returns `rejected` (denied sensitive columns present). Caller rejects the entry if `rejected` is non-empty.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/lib/syncPolicy.test.ts`:
```ts
import { applyWritePolicy } from './syncPolicy';

const realUsers = new Map([['users', new Set(['id', 'name', 'role', 'pin_hash', 'permission_overrides', 'active', 'expires_at', 'updated_at'])]]);

test('applyWritePolicy rejects privilege columns on users', () => {
  const { rejected } = applyWritePolicy(
    'users', 'UPDATE',
    { id: 'self', role: 'full_admin', permission_overrides: { system_settings: true } },
    'self', realUsers,
  );
  assert.deepEqual(rejected.sort(), ['permission_overrides', 'role']);
});

test('applyWritePolicy allows a benign users.name edit', () => {
  const { row, rejected } = applyWritePolicy('users', 'UPDATE', { id: 'self', name: 'New Name' }, 'self', realUsers);
  assert.deepEqual(rejected, []);
  assert.deepEqual(row, { id: 'self', name: 'New Name' });
});

test('applyWritePolicy forces attribution to caller on INSERT', () => {
  const realJobs = new Map([['jobs', new Set(['id', 'name', 'created_by'])]]);
  const { row } = applyWritePolicy('jobs', 'INSERT', { id: 'j', name: 'J', created_by: 'someone-else' }, 'caller', realJobs);
  assert.equal(row.created_by, 'caller');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npm test` → FAIL (`applyWritePolicy` undefined).

- [ ] **Step 3: Implement**

Add to `apps/api/src/lib/syncPolicy.ts`:
```ts
// Columns a client may NEVER write via generic sync — even though they are real
// columns — because they confer privilege / are credentials / are server-owned.
// Set ONLY through dedicated permissioned paths (REST /users, teams manager
// endpoint) or by the server. Kills mass-assignment on the write-gated tables.
export const SENSITIVE_DENY: Record<string, Set<string>> = {
  users: new Set(['role', 'pin_hash', 'pin_set', 'permission_overrides', 'active', 'expires_at', 'enrollment_code_hash']),
  team_members: new Set(['is_manager']),
};

// Attribution columns: forced to the caller on INSERT (can't claim another creator)
// and dropped on UPDATE (creator can't be reassigned). NOTE: locations.owner_user_id
// is intentionally NOT here — it's a deliberate assignment, not "who created it".
export const ATTRIBUTION_COLUMNS: Record<string, string[]> = {
  jobs: ['created_by'], repairs: ['created_by'], media: ['uploaded_by'], team_members: ['added_by'],
};

export function applyWritePolicy(
  table: string,
  op: 'INSERT' | 'UPDATE',
  payload: Record<string, unknown>,
  callerUserId: string,
  realColumns: Map<string, Set<string>>,
): { row: Record<string, unknown>; rejected: string[] } {
  const { kept } = keepRealColumns(table, payload, realColumns);
  const deny = SENSITIVE_DENY[table];
  const rejected: string[] = [];
  const row: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kept)) {
    if (deny && deny.has(k)) { rejected.push(k); continue; }
    row[k] = v;
  }
  for (const c of ATTRIBUTION_COLUMNS[table] ?? []) {
    if (op === 'INSERT') row[c] = callerUserId;
    else delete row[c];
  }
  return { row, rejected };
}
```

- [ ] **Step 4: Run test to verify it passes** — `cd apps/api && npm test` → PASS.

- [ ] **Step 5: Wire into `sync.ts` — replace `sanitizePayload` with `applyWritePolicy`**

In `applyEntry`, replace the UPDATE branch's `sanitizePayload(...)` + `keepRealColumns(...)` with a single `applyWritePolicy` call, and reject the whole entry if `rejected.length`:
```ts
  if (operation === 'UPDATE') {
    const { row, rejected } = applyWritePolicy(table_name, 'UPDATE', payload, callerUserId, realColumns);
    if (rejected.length) throw new Error(`Forbidden columns: ${rejected.join(', ')}`);
    const cols = Object.keys(row).filter(k => k !== '__version' && k !== 'synced_at' && !keys.includes(k));
    if (cols.length === 0) return;
    // ...existing setClause/where build, but source values from `row`, not `payload`...
  }
```
Do the same for the INSERT branch (`applyWritePolicy(table_name, 'INSERT', ...)`, throw on `rejected`, build `allKeys` from `row`). Delete the now-unused `sanitizePayload`, `SERVER_ONLY_COLUMNS`, and the local `ATTRIBUTION_COLUMNS` from `sync.ts` (they now live in `syncPolicy.ts`; import `applyWritePolicy`). Keep `keepRealColumns` import only if still referenced elsewhere.

- [ ] **Step 6: Typecheck + commit**

`cd apps/api && npx tsc --noEmit` → 0.
```bash
git add apps/api/src/lib/syncPolicy.ts apps/api/src/lib/syncPolicy.test.ts apps/api/src/routes/sync.ts
git commit -m "fix(sync): default-deny sensitive columns on generic upsert (mass-assignment C2)"
```

### Task A3: Operation-level permission gating for operational tables (H1)

**Files:**
- Modify: `apps/api/src/lib/syncPolicy.ts`, `apps/api/src/lib/syncPolicy.test.ts`, `apps/api/src/routes/sync.ts`

**Interfaces:**
- Produces: `requiredOperationPerm(table, op): string | null | 'DENY'` — the permission needed to write `table` via op; `null` = none beyond auth (e.g. `activity_log`, `stock_by_location` ADJUST/absolute already handled); `'DENY'` = operational table with no mapping → reject (fail closed). Privileged tables return `null` here (they're gated by the existing `PRIVILEGED_TABLE_PERM`).

- [ ] **Step 1: Write the failing test**
```ts
import { requiredOperationPerm } from './syncPolicy';

test('operational tables map op -> permission', () => {
  assert.equal(requiredOperationPerm('inventory_items', 'DELETE'), 'delete_inventory');
  assert.equal(requiredOperationPerm('inventory_items', 'UPDATE'), 'edit_inventory');
  assert.equal(requiredOperationPerm('locations', 'UPDATE'), 'manage_locations');
  assert.equal(requiredOperationPerm('jobs', 'INSERT'), 'create_jobs');
});

test('privileged tables return null here (gated elsewhere)', () => {
  assert.equal(requiredOperationPerm('users', 'UPDATE'), null);
  assert.equal(requiredOperationPerm('activity_log', 'INSERT'), null);
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (`requiredOperationPerm` undefined).

- [ ] **Step 3: Implement**

Add to `syncPolicy.ts`:
```ts
type Op = 'INSERT' | 'UPDATE' | 'DELETE';

// Operational-table op -> required permission. Privileged tables are intentionally
// ABSENT (gated by PRIVILEGED_TABLE_PERM in the push handler) and resolve to null.
// activity_log / stock_by_location have their own handling and resolve to null.
const OPERATION_PERM: Record<string, Partial<Record<Op, string>>> = {
  inventory_items: { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'delete_inventory' },
  equipment_units: { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'delete_inventory' },
  locations:       { INSERT: 'manage_locations', UPDATE: 'manage_locations', DELETE: 'manage_locations' },
  jobs:            { INSERT: 'create_jobs', UPDATE: 'create_jobs', DELETE: 'close_jobs' },
  repairs:         { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  taxonomy_types:  { INSERT: 'add_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
  media:           { INSERT: 'upload_media', UPDATE: 'upload_media', DELETE: 'upload_media' },
  stock_by_location: { INSERT: 'checkin_inventory', UPDATE: 'edit_inventory', DELETE: 'edit_inventory' },
};

// Tables handled entirely by dedicated logic / gated separately → no op-perm here.
const OPERATION_PERM_EXEMPT = new Set(['activity_log', 'users', 'role_settings', 'app_config', 'teams', 'team_members']);

export function requiredOperationPerm(table: string, op: Op): string | null | 'DENY' {
  if (OPERATION_PERM_EXEMPT.has(table)) return null;
  const perm = OPERATION_PERM[table]?.[op];
  return perm ?? 'DENY'; // operational table with no mapping → fail closed
}
```
> **DECISION (adjust to taste, values are concrete defaults):** `repairs`/`taxonomy_types` reuse inventory perms (no dedicated permission exists); `stock_by_location` absolute UPDATE requires `edit_inventory` while the normal signed-delta path is `operation: 'ADJUST'` (unchanged, needs only auth — it's the crew checkout/checkin surface). Change these if the product wants stricter/looser gating.

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Wire into the `/sync/push` loop**

In `sync.ts` push handler, import `requiredOperationPerm`, and inside the `for (const entry of entries)` loop, AFTER the `PRIVILEGED_TABLE_PERM` gate and BEFORE `applyEntry`, add (only for non-ADJUST ops, since ADJUST is the delta stock path):
```ts
      if (entry.operation !== 'ADJUST') {
        const opPerm = requiredOperationPerm(entry.table_name, entry.operation as 'INSERT' | 'UPDATE' | 'DELETE');
        if (opPerm === 'DENY') {
          conflicts.push({ id: entry.id, error: `Forbidden: ${entry.table_name}/${entry.operation} not permitted via sync` });
          continue;
        }
        if (opPerm && !can(opPerm)) {
          request.log.warn({ userId, role: caller.role, table: entry.table_name, operation: entry.operation, opPerm }, 'sync push op denied (authz)');
          conflicts.push({ id: entry.id, error: `Forbidden: ${entry.table_name}/${entry.operation} requires ${opPerm}` });
          continue;
        }
      }
```

- [ ] **Step 6: Typecheck + commit**

`cd apps/api && npx tsc --noEmit` → 0.
```bash
git add apps/api/src/lib/syncPolicy.ts apps/api/src/lib/syncPolicy.test.ts apps/api/src/routes/sync.ts
git commit -m "fix(sync): gate operational-table writes on per-operation permission (H1)"
```

### Task A4: Server-authoritative `updated_at` + activity_log enum (M5, L3)

**Files:**
- Modify: `apps/api/src/lib/syncPolicy.ts`, `apps/api/src/lib/syncPolicy.test.ts`, `apps/api/src/routes/sync.ts`

**Interfaces:**
- Produces: `ACTIVITY_ACTIONS: Set<string>`, `ACTIVITY_ENTITY_TYPES: Set<string>`, and `isAllowedActivity(action, entityType): boolean`.

- [ ] **Step 1: Write the failing test**
```ts
import { isAllowedActivity } from './syncPolicy';
test('activity_log action/entity_type constrained to enum', () => {
  assert.equal(isAllowedActivity('checkout', 'item'), true);
  assert.equal(isAllowedActivity('DROP TABLE users', 'item'), false);
  assert.equal(isAllowedActivity('checkout', 'nonsense'), false);
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

Add to `syncPolicy.ts` (enumerate from the actions the app actually logs — grep `appendLog(` / `action:` in `apps/mobile/src` to confirm the set; the list below covers the current call sites — verify and extend during implementation):
```ts
export const ACTIVITY_ACTIONS = new Set([
  'login', 'pin_set', 'checkout', 'checkin', 'transfer', 'adjust_stock',
  'add_inventory', 'edit_inventory', 'delete_inventory', 'create_job', 'close_job',
  'create_location', 'edit_location', 'role_color_changed', 'role_permission_changed',
  'role_min_pin_changed', 'user_created', 'user_updated', 'team_created', 'team_updated',
  'repair_created', 'repair_updated', 'media_uploaded',
]);
export const ACTIVITY_ENTITY_TYPES = new Set([
  'user', 'item', 'equipment_unit', 'location', 'job', 'team', 'role_settings', 'repair', 'media',
]);
export function isAllowedActivity(action: unknown, entityType: unknown): boolean {
  return typeof action === 'string' && ACTIVITY_ACTIONS.has(action)
      && typeof entityType === 'string' && ACTIVITY_ENTITY_TYPES.has(entityType);
}
```

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Wire into `sync.ts`**

(a) In the `activity_log` branch of `applyEntry`, before the INSERT, add:
```ts
    if (!isAllowedActivity(payload.action, payload.entity_type)) {
      throw new Error('Invalid activity_log action/entity_type');
    }
```
(b) Force server-authoritative `updated_at` on generic upserts: in the UPDATE branch build, always append `updated_at = NOW()` to the SET clause (and remove any client `updated_at` from `cols`); in the INSERT branch, if the table has an `updated_at` real column, set it via `NOW()` in VALUES and the `DO UPDATE`. Concretely, filter `updated_at` out of `cols`/`allKeys` and add a literal `updated_at = NOW()` fragment (guarded by `realColumns.get(table_name)?.has('updated_at')`). Leave `created_at` client-supplied on INSERT (offline events keep their real time), matching the activity_log rationale.

- [ ] **Step 6: Typecheck + commit**
```bash
cd apps/api && npx tsc --noEmit
git add apps/api/src/lib/syncPolicy.ts apps/api/src/lib/syncPolicy.test.ts apps/api/src/routes/sync.ts
git commit -m "fix(sync): server-authoritative updated_at + activity_log enum (M5,L3)"
```

### Task A5: Column-projected reads on `/sync/pull` + `/sync/full` (M1)

**Files:**
- Modify: `apps/api/src/lib/syncPolicy.ts`, `apps/api/src/lib/syncPolicy.test.ts`, `apps/api/src/routes/sync.ts`

**Interfaces:**
- Produces: `selectColumnsFor(table, canViewFinancial): string` — returns the safe, server-defined SELECT list for a table given the caller's `view_financial_data`. Replaces the existing `selectColsFor`.

- [ ] **Step 1: Write the failing test**
```ts
import { selectColumnsFor } from './syncPolicy';
test('jobs hides PII/financial columns without view_financial_data', () => {
  const restricted = selectColumnsFor('jobs', false);
  assert.ok(!/customer_name|site_address|insurance_carrier/.test(restricted));
  const full = selectColumnsFor('jobs', true);
  assert.ok(/customer_name/.test(full));
});
test('users never exposes pin_hash or enrollment_code_hash', () => {
  const cols = selectColumnsFor('users', true);
  assert.ok(!/pin_hash|enrollment_code_hash/.test(cols));
});
test('app_config only exposes non-secret keys via projection marker', () => {
  assert.equal(selectColumnsFor('app_config', false), 'key, value, updated_at');
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

Add to `syncPolicy.ts`:
```ts
// Server-defined SELECT lists (never '*', never client-influenced). PII/financial
// columns on jobs are gated behind view_financial_data.
const JOBS_BASE = 'id, name, status, type, job_number, reference_number, site_location_id, created_by, created_at, updated_at';
const JOBS_SENSITIVE = ', customer_name, site_address, description, insurance_carrier';
const USERS_COLS = 'id, name, role, pin_length_required, pin_set, permission_overrides, active, expires_at, created_at, updated_at';

export function selectColumnsFor(table: string, canViewFinancial: boolean): string {
  if (table === 'users') return USERS_COLS;
  if (table === 'jobs') return canViewFinancial ? JOBS_BASE + JOBS_SENSITIVE : JOBS_BASE;
  if (table === 'app_config') return 'key, value, updated_at'; // no secret columns exist today; explicit projection prevents future leakage
  return '*';
}
```
> **NOTE:** `app_config` currently has no secret columns, but projecting it explicitly (rather than `*`) means a future secret column won't silently sync to every device. If secret *rows* are ever stored, add a `WHERE key = ANY(<public keys>)` filter here too.

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Wire into `sync.ts`**

Delete the local `SELECT_COLUMNS`/`selectColsFor`. In BOTH `/full` and `/pull`, resolve the caller's `view_financial_data` once (reuse the same DB-perm resolution as `/push` — extract a small `resolveCaller(pg, userId)` helper or inline the query + `userHasPermission(...,'view_financial_data',...)`), then call `selectColumnsFor(table, canViewFinancial)` instead of `selectColsFor(table)`. `/full` and `/pull` already have `authenticate`; add the same `request.user.sub` → 403-if-unknown guard used in `/push`.

- [ ] **Step 6: Typecheck + full track test + commit**
```bash
cd apps/api && npx tsc --noEmit && npm test
git add apps/api/src/lib/syncPolicy.ts apps/api/src/lib/syncPolicy.test.ts apps/api/src/routes/sync.ts
git commit -m "fix(sync): column-project pull/full reads, gate jobs PII/financial (M1)"
```

---

## Track B — Authentication hardening

### Task B1: Migration + enrollment-code issuance on user creation (C3 server, part 1)

**Files:**
- Create: `apps/api/src/db/migrations/026_enrollment_code.sql`
- Modify: `apps/api/src/routes/users.ts` (the `POST /users` create handler)

**Interfaces:**
- Produces: `POST /users` response gains `enrollment_code: string` (6-digit, shown ONCE to the admin). Column `users.enrollment_code_hash TEXT` (bcrypt), nulled after successful set-pin.

- [ ] **Step 1: Write the migration**

`apps/api/src/db/migrations/026_enrollment_code.sql`:
```sql
-- One-time enrollment code (bcrypt hash) required to set a first PIN. Issued when
-- an admin creates the user; cleared once the PIN is set. Server-only, never synced.
ALTER TABLE users ADD COLUMN IF NOT EXISTS enrollment_code_hash TEXT;
```

- [ ] **Step 2: Issue the code on create**

In `apps/api/src/routes/users.ts` `POST /users` handler, after generating the row, generate a 6-digit code, bcrypt-hash it into `enrollment_code_hash`, and return the plaintext once:
```ts
import { randomInt } from 'node:crypto';
// ...inside the create handler, before INSERT:
const enrollmentCode = String(randomInt(0, 1_000_000)).padStart(6, '0');
const enrollmentCodeHash = await bcrypt.hash(enrollmentCode, 10);
// include enrollment_code_hash in the INSERT column list + values
// ...after INSERT succeeds:
return reply.status(201).send({ ...createdRow, enrollment_code: enrollmentCode });
```
Confirm the existing create handler already requires `manage_users` (it does — `requirePermission`/`callerCan`). Ensure `enrollment_code_hash` is NOT in any SELECT that returns to non-admins (it isn't in roster or token responses).

- [ ] **Step 3: Verify locally**

Run migrations against a local/scratch DB (`npm run db:migrate`) and confirm the column exists:
```bash
psql "$DATABASE_URL" -c "\d users" | grep enrollment_code_hash
```
Expected: the column is listed.

- [ ] **Step 4: Commit**
```bash
git add apps/api/src/db/migrations/026_enrollment_code.sql apps/api/src/routes/users.ts
git commit -m "feat(auth): issue one-time enrollment code on user creation (C3)"
```

### Task B2: `/auth/set-pin` requires enrollment code (C3 server, part 2)

**Files:**
- Modify: `apps/api/src/routes/auth.ts`

**Interfaces:**
- Produces (contract for Track D5): `POST /auth/set-pin` now requires body `{ user_id, pin, enrollment_code }`. Missing/invalid code → `401 { error: 'Invalid enrollment code' }`. On success, `enrollment_code_hash` is cleared. Rate-limit + `pin_set` guard unchanged.

- [ ] **Step 1: Add `enrollment_code` to the schema + verify it**

In the `/auth/set-pin` route (`auth.ts:167`), add `enrollment_code: { type: 'string', minLength: 4, maxLength: 12 }` to `properties` and to `required`. Extend the SELECT (line ~193) to include `enrollment_code_hash`. After the existing `pin_set` check, add:
```ts
    if (!user.enrollment_code_hash) {
      recordFail(lockKey);
      return reply.status(403).send({ error: 'Enrollment not available for this account' });
    }
    const codeOk = await bcrypt.compare(request.body.enrollment_code, user.enrollment_code_hash);
    if (!codeOk) {
      recordFail(lockKey);
      return reply.status(401).send({ error: 'Invalid enrollment code' });
    }
```
Add `enrollment_code_hash = NULL` to the `UPDATE users SET ...` on success (line ~211) so the code is single-use.

- [ ] **Step 2: Manual verification (curl, against local dev server)**

Start the API (`npm run dev`), create a user via `POST /users` (as an admin token) to get an `enrollment_code`, then:
```bash
# wrong code → 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:3000/auth/set-pin \
  -H 'Content-Type: application/json' -d '{"user_id":"<id>","pin":"1234","enrollment_code":"000000"}'   # expect 401
# correct code → 200 + jwt, and a second attempt → 409 (pin already set)
```

- [ ] **Step 3: Typecheck + commit**
```bash
cd apps/api && npx tsc --noEmit
git add apps/api/src/routes/auth.ts
git commit -m "fix(auth): require one-time enrollment code to set first PIN (C3)"
```

### Task B3: Refresh expiry check + PIN backoff + roster rate-limit (L2, L1, L5)

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Create: `apps/api/src/lib/auth-lockout.test.ts`

**Interfaces:**
- Produces: `nextLockMs(failCount): number` (exponential backoff) extracted as a pure exported helper for testing.

- [ ] **Step 1: Write the failing test**

`apps/api/src/lib/auth-lockout.test.ts`:
```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextLockMs } from '../routes/auth';

test('exponential backoff grows with fail count and caps', () => {
  assert.equal(nextLockMs(3), 0);            // below threshold, no lock
  assert.ok(nextLockMs(5) > 0);
  assert.ok(nextLockMs(8) > nextLockMs(5));
  assert.ok(nextLockMs(50) <= 60 * 60_000);  // capped at 1h
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (`nextLockMs` not exported).

- [ ] **Step 3: Implement**

In `auth.ts`, export a pure backoff function and use it in `recordFail`:
```ts
export function nextLockMs(count: number): number {
  if (count < 5) return 0;
  return Math.min(60 * 60_000, 60_000 * 2 ** (count - 5)); // 1m,2m,4m… cap 1h
}
```
Update `recordFail` to `r.lockedUntil = now + nextLockMs(r.count)` (replacing the flat `LOCK_MS` when `count >= MAX_ATTEMPTS`; keep `MAX_ATTEMPTS` as the first-lock threshold or fold it into `nextLockMs`'s `< 5`). In `/auth/refresh` (line ~255), add expiry to the SELECT and the guard:
```ts
`SELECT id, name, role, active, expires_at FROM users WHERE id = $1`
// ...
if (!user || !user.active || (user.expires_at && new Date(user.expires_at) < new Date())) {
  return reply.status(403).send({ error: 'Account inactive or expired' });
}
```
Add a lightweight IP-keyed limiter to `GET /auth/roster` (reuse the `attempts` map with key `roster:${request.ip}`, e.g. 30/15min) returning 429 when exceeded.

- [ ] **Step 4: Run test to verify it passes** — `cd apps/api && npm test` → PASS.

- [ ] **Step 5: Typecheck + commit**
```bash
cd apps/api && npx tsc --noEmit
git add apps/api/src/routes/auth.ts apps/api/src/lib/auth-lockout.test.ts
git commit -m "fix(auth): exponential PIN backoff, refresh expiry check, roster rate-limit (L1,L2,L5)"
```

---

## Track C — Media & config hardening

### Task C1: Media URL trust + MinIO fail-closed + upload size cap (M2, M3, L6)

**Files:**
- Modify: `apps/api/src/routes/media.ts`

- [ ] **Step 1: Fail closed on MinIO creds**

Replace `media.ts:15-18` with a startup guard:
```ts
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY;
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY;
if (!MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
  throw new Error('MINIO_ACCESS_KEY and MINIO_SECRET_KEY must be set (no default credentials)');
}
const credentials = { accessKeyId: MINIO_ACCESS_KEY, secretAccessKey: MINIO_SECRET_KEY };
```

- [ ] **Step 2: Bind `POST /media` to a server-issued key, not a client URL**

In `POST /media` (line ~123), stop trusting `url`. Require the client to send back the `key` returned by `/upload-url`, and validate it: `key` must match `^${entity_type}/${entity_id}/[0-9a-f-]{36}\.[a-z0-9]{2,5}$`. Reconstruct the stored `url` server-side from `PUBLIC_MEDIA_URL + '/' + key`. Reject any `key` whose prefix ≠ `entity_type/entity_id/`:
```ts
const KEY_RE = /^[a-z_]+\/[a-zA-Z0-9_-]{1,64}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$/;
// ...
if (!KEY_RE.test(key) || !key.startsWith(`${entity_type}/${entity_id}/`)) {
  return reply.status(400).send({ error: 'Invalid media key' });
}
const url = `${process.env.PUBLIC_MEDIA_URL ?? 'https://localhost/media'}/${key}`;
```
Update the `SaveMediaBody` interface + JSON schema: replace `url` with `key` (keep `thumbnail_url` optional but validate it the same way or drop it). In `DELETE /media/:id`, derive the object key the same server-controlled way (from the stored key/url) and additionally assert its prefix matches the row's `entity_type/entity_id` before `DeleteObjectCommand` — so even a legacy row can't point outside its entity.

- [ ] **Step 3: Cap presigned PUT size**

In `/upload-url`, bound the object size by signing a max content-length. With `@aws-sdk/s3-request-presigner` add a guard: accept an optional `content_length` in the body, validate `<= 25 * 1024 * 1024`, and reject oversized. (Full `POST`-policy enforcement is a larger change; at minimum reject a missing/oversized declared length so the client can't request an unbounded PUT.)

- [ ] **Step 4: Typecheck + manual verify + commit**
```bash
cd apps/api && npx tsc --noEmit
```
Manual: with a valid token, `POST /media` with a `key` pointing at another entity → expect 400; with the matching key → 201.
```bash
git add apps/api/src/routes/media.ts
git commit -m "fix(media): bind saves to server-issued keys, fail-closed MinIO creds, cap upload size (M2,M3,L6)"
```

### Task C2: Global error handler + security headers (M4, L4)

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Register a scrubbing error handler**

In `index.ts` after the plugins are registered, add:
```ts
app.setErrorHandler((err, request, reply) => {
  request.log.error({ err }, 'request error');
  const status = (err as any).statusCode ?? 500;
  if (status >= 500) return reply.status(status).send({ error: 'Internal Server Error' });
  // preserve intentional 4xx messages (validation, auth) but never internal 5xx detail
  return reply.status(status).send({ error: err.message });
});
```

- [ ] **Step 2: Register helmet**

Near the other `app.register(...)` calls:
```ts
import helmet from '@fastify/helmet';
await app.register(helmet, { contentSecurityPolicy: false }); // JSON+image API; CSP off to avoid breaking presigned image hosts
```

- [ ] **Step 3: Verify + commit**
```bash
cd apps/api && npx tsc --noEmit && npm run build
# smoke: a route that throws should return {"error":"Internal Server Error"} with no stack
git add apps/api/src/index.ts
git commit -m "fix(api): generic 5xx error handler + helmet security headers (M4,L4)"
```

---

## Track D — Client hardening (mobile + web)

D1–D4 are independent. **D5 depends on Track B2's `/auth/set-pin` contract** and lands after B.

### Task D1: Remove stale/false PIN-hash comment (L9)

**Files:** Modify `apps/mobile/src/auth/pin.ts`

- [ ] **Step 1:** Delete the comment at `pin.ts:14-15` that claims the PIN hash is synced to the device / references a non-existent `verifyPinLocal`. Replace with one accurate line: `// PIN is verified server-side only (see verifyPin below); no hash is ever stored on device.`
- [ ] **Step 2: Commit**
```bash
git add apps/mobile/src/auth/pin.ts
git commit -m "docs(mobile): remove false pin-hash-synced comment (L9)"
```

### Task D2: Harden map WebViews (L7)

**Files:** Modify `apps/mobile/src/components/MapDisplay.tsx`, `apps/mobile/src/components/MapPickerModal.tsx`

- [ ] **Step 1:** In both WebViews, narrow `originWhitelist` from `['*']` to `['https://*.openstreetmap.org', 'https://unpkg.com', 'about:blank']`, and add `setSupportMultipleWindows={false}`.
- [ ] **Step 2:** In `MapDisplay.buildHtml` (`:42-46`), coerce coordinates before interpolation: `const lat = Number(latitude); const lng = Number(longitude); if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '<html></html>';` — mirroring `MapPickerModal`'s numeric guard.
- [ ] **Step 3: Typecheck + commit**
```bash
cd apps/mobile && npx tsc --noEmit
git add src/components/MapDisplay.tsx src/components/MapPickerModal.tsx
git commit -m "fix(mobile): narrow map WebView origins + coerce coords (L7)"
```

### Task D3: HTTPS guard on API base in production (L8)

**Files:** Modify `apps/mobile/src/auth/session.ts` (or wherever `API_BASE` is first defined/exported)

- [ ] **Step 1:** Add a dev-only assertion where `API_BASE` is defined:
```ts
if (!__DEV__ && !API_BASE.startsWith('https://')) {
  throw new Error('EXPO_PUBLIC_API_URL must be https in production');
}
```
- [ ] **Step 2: Typecheck + commit**
```bash
cd apps/mobile && npx tsc --noEmit
git add src/auth/session.ts
git commit -m "fix(mobile): require https API base in production (L8)"
```

### Task D4: Shorten/remove web refresh-token exposure (M7)

**Files:** Modify `apps/mobile/src/auth/session.web.ts`

- [ ] **Step 1:** On web, stop persisting the long-lived refresh token in plaintext IndexedDB. Minimal, self-contained option (no server change): keep only the 15-min JWT in IndexedDB and hold the refresh token in memory only (module variable), so a page reload requires PIN re-entry but no 7-day token sits at rest. In `saveSession`/`idbSet` (`:57-71`), write the JWT + userId to IndexedDB but keep `refresh` in a module-scoped variable; `getRefreshToken()` reads the in-memory value.
- [ ] **Step 2:** Verify in-browser (`web` build) that login works and a reload correctly falls back to the unlock/login screen instead of silently resuming from a stored refresh token.
- [ ] **Step 3: Typecheck + commit**
```bash
cd apps/mobile && npx tsc --noEmit
git add src/auth/session.web.ts
git commit -m "fix(web): keep refresh token in memory only, not plaintext IndexedDB (M7)"
```
> **DECISION:** The robust long-term fix is a server-set `HttpOnly; Secure; SameSite` refresh cookie (needs an API change and would move to Track B/C). The in-memory approach above closes the at-rest exposure without a protocol change; choose the cookie approach if persistent web sessions are required.

### Task D5: Enrollment-code entry in first-launch onboarding (C3 mobile — depends on B2)

**Files:** Modify `apps/mobile/src/auth/pin.ts` (the `setPin` call), `apps/mobile/app/(auth)/first-launch.tsx` (or the set-PIN screen), and the set-pin request builder.

**Interfaces:**
- Consumes (from B2): `POST /auth/set-pin` body now `{ user_id, pin, enrollment_code }`; `401 { error: 'Invalid enrollment code' }` on mismatch.

- [ ] **Step 1:** Add an "Enrollment code" text input to the first-launch / set-PIN screen (shown only in the `pin_set === 0` path), 6-digit numeric.
- [ ] **Step 2:** Thread the code into the set-pin request: update the client `setPin(userId, pin, enrollmentCode)` to include `enrollment_code` in the JSON body; surface the `401 Invalid enrollment code` as an inline error.
- [ ] **Step 3: Typecheck + commit**
```bash
cd apps/mobile && npx tsc --noEmit
git add src/auth/pin.ts 'app/(auth)/first-launch.tsx'
git commit -m "feat(mobile): enrollment-code entry during first-login PIN setup (C3)"
```

---

## Integration & Verification (after all tracks merge)

- [ ] **I1: Full API typecheck + unit tests**
```bash
cd apps/api && npx tsc --noEmit && npm test   # all node:test files pass
cd ../mobile && npx tsc --noEmit
```

- [ ] **I2: Deploy migration 026 to prod** (per project deploy flow — pivot via Unraid `root@192.168.1.239`, `inventorypro-postgres-1`). Confirm:
```bash
docker exec inventorypro-postgres-1 psql -U inventorypro -d inventorypro -tAc \
  "SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='enrollment_code_hash';"   # → enrollment_code_hash
```

- [ ] **I3: Deploy the API image**, then run the prod smoke checks (as a low-tier crew JWT `$CREW` obtained via a test crew account):
```bash
API=https://api.plexcontrol.com
# C1: injection payload key on an operational table → rejected as a conflict, no data leak
curl -s -X POST $API/sync/push -H "Authorization: Bearer $CREW" -H 'Content-Type: application/json' \
  -d '{"entries":[{"id":"t1","operation":"UPDATE","table_name":"jobs","payload":{"id":"any","name = (SELECT pin_hash FROM users LIMIT 1)--":"x"}}]}' \
  | grep -q '"conflicts"' && echo "C1 blocked"
# C2: users role write as non-admin → conflict "Forbidden columns"
curl -s -X POST $API/sync/push -H "Authorization: Bearer $CREW" -H 'Content-Type: application/json' \
  -d '{"entries":[{"id":"t2","operation":"UPDATE","table_name":"users","payload":{"id":"self","role":"full_admin"}}]}' \
  | grep -qi 'forbidden' && echo "C2 blocked"
# H1: crew deletes an inventory item → conflict requires delete_inventory
curl -s -X POST $API/sync/push -H "Authorization: Bearer $CREW" -H 'Content-Type: application/json' \
  -d '{"entries":[{"id":"t3","operation":"DELETE","table_name":"inventory_items","payload":{"id":"any"}}]}' \
  | grep -qi 'requires delete_inventory' && echo "H1 blocked"
# C3: set-pin without a valid enrollment code → 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST $API/auth/set-pin -H 'Content-Type: application/json' \
  -d '{"user_id":"<un-onboarded id>","pin":"1234","enrollment_code":"000000"}'   # → 401
# M1: crew pull → jobs rows carry no customer_name
curl -s "$API/sync/pull?since=1970-01-01" -H "Authorization: Bearer $CREW" | grep -q 'customer_name' && echo "LEAK" || echo "M1 ok"
```

- [ ] **I4: Rebuild + hotload the app** (deploy-android Track B) and confirm: normal crew checkout/checkin (ADJUST) still syncs; admin role/color edits still sync; first-launch onboarding now asks for the enrollment code.

- [ ] **I5: Commit any integration fixups**, then open/refresh the PR.

---

## Self-Review

**Spec coverage** (audit finding → task):
- C1 injection → A1. C2 mass-assignment → A2. H1 operational authz → A3. M5 updated_at / L3 activity enum → A4. M1 read projection → A5.
- C3 takeover → B1 (issue code) + B2 (require code) + D5 (mobile entry). L1 backoff / L2 refresh-expiry / L5 roster-limit → B3.
- M2 media URL-trust / M3 MinIO creds / L6 size cap → C1. M4 error handler / L4 helmet → C2.
- M7 web refresh token → D4. L7 map WebView → D2. L8 https guard → D3. L9 stale comment → D1.
- Not code-fixed (operational, called out for the user): **M6** (batch `maxItems` + transaction) — add `maxItems: 500` to the `/sync/push` body schema and wrap the entry loop in a transaction; folded as an optional Step in A3 if desired. Flagged here so it isn't silently dropped.

**Placeholder scan:** no TBD/"handle errors"/"similar to"—each code step carries concrete code. The two `DECISION` notes (A3 perm choices, D4 cookie-vs-memory) give concrete defaults plus the alternative.

**Type consistency:** `keepRealColumns` (A1) → consumed by `applyWritePolicy` (A2); `requiredOperationPerm` returns `string | null | 'DENY'` used verbatim in A3 wiring; `selectColumnsFor(table, canViewFinancial)` (A5) replaces `selectColsFor` at both call sites; `nextLockMs(count)` (B3) exported and imported by its test; `/auth/set-pin` body `{user_id, pin, enrollment_code}` defined in B2 and consumed in D5.

**One gap fixed inline:** added M6 note above (was uncovered); left as an optional hardening step to keep the critical path lean.
