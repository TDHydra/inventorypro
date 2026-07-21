# Media Share + Push (#87 + #148) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Header-camera quick-photo flow filing photos to a job or an audience pool, with an immediate push (users/team audiences) that deep-links the recipient to the photo.

**Architecture:** Reuse the `media` table + MinIO presign/upload/outbox pipeline end-to-end. Two new TEXT columns (`audience`, `audience_user_ids`) flow through mobile SQLite, web sql.js, Postgres, and both sync directions. Pool visibility is enforced in `mediaScopeSql`; the push is a fire-and-forget hook in `/sync/push` mirroring the chat-message hook, routed through `deliver()`. Capture UI is a singleton host (ConfirmSheetHost pattern) driven by a pure state machine.

**Tech Stack:** Expo RN + expo-image-picker, op-sqlite/sql.js, Fastify + pg, Expo Push, node:test.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-21-media-share-push-design.md` (+ the #148 spec it adopts). Board: #87, #148.
- Branch: `feat/87-media-share` off `main`, in the MAIN checkout (Metro serves it for hotload). Commits `feat(#87): …` / `feat(#148): …`, each ending with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. Never `git add -A`.
- Migration numbers: **mobile 052, API 064** — next free at landing time. (The vehicles reservations move to 053/054 + 065/066; those tracks have not started. Re-check the migration dirs immediately before creating the files; if something else landed, take the next free and say so.)
- `audience` values: exactly `'team' | 'everyone' | 'users'`; NULL for job/entity photos. `audience_user_ids`: TEXT holding a JSON array of user UUIDs, only when `audience='users'`. TEXT, never a PG enum.
- Push: `users` + `team` audiences only; `'everyone'` gets inbox rows but NO push; job photos get nothing. Sender never notified. Push payload `data: { screen: 'media', id: <mediaId> }`.
- Sync checklist (`docs/SYNC-MIGRATION-CHECKLIST.md`) binds Tasks 1 and 4: server push path is generic (DB-introspected) but mobile `pull.ts` TABLE_UPSERT_SQL + rowToValues must stay 1:1 (pullColumns.test.ts enforces).
- No new dependencies. `expo.version` is currently 1.3.5.
- Commands: mobile tests `pnpm test` from `apps/mobile` (node:test), single file `node --import tsx --import ./src/test/setupGlobals.mjs --test <file>`; API tests `pnpm test` from `apps/api`; typecheck `npx tsc --noEmit` in each.

---

### Task 1: API — migration 064, audience validation, 'pool' entity type

**Files:**
- Create: `apps/api/src/db/migrations/064_media_audience.sql`
- Modify: `apps/api/src/lib/syncPolicy.ts` (MEDIA_ENTITY_TYPES ~line 229; `validateMediaWrite` lines 278-304)
- Test: `apps/api/src/lib/syncPolicy.test.ts` (append)

**Interfaces:**
- Produces: `AUDIENCE_VALUES: Set<string>` exported from syncPolicy.ts; `validateMediaWrite` rejects bad audiences; `MEDIA_ENTITY_TYPES` contains `'pool'` (this alone opens `routes/media.ts` upload-url + POST /media, which use the same set). Tasks 2-3 rely on the columns existing; Task 4's outbox payloads must pass this validation.

- [ ] **Step 1: Migration** — create `064_media_audience.sql`:

```sql
-- Migration 064: media pool-share audience (#87/#148). Mirrors mobile 052.
-- audience: 'team' | 'everyone' | 'users' — TEXT, NEVER a PG enum (enum cols
-- are TEXT on mobile SQLite; remapping enum values crash-loops the API).
-- audience_user_ids: JSON array of user UUIDs (TEXT), only when audience='users'.
-- NULL on both = job/entity photo (legacy rows unaffected — no updated_at bump,
-- so no re-download storm; pool rows are only ever created after this deploys).
-- SYNCED columns: server pull uses SELECT * for media (no _COLS list) and push
-- is DB-introspected, so no sync.ts column-list edit is needed server-side;
-- mobile pull.ts IS hardcoded — see mobile migration 052 (same change set).
ALTER TABLE media ADD COLUMN IF NOT EXISTS audience TEXT;
ALTER TABLE media ADD COLUMN IF NOT EXISTS audience_user_ids TEXT;
CREATE INDEX IF NOT EXISTS idx_media_pool ON media (entity_type, audience) WHERE entity_type = 'pool';
```

- [ ] **Step 2: Failing tests** — append to `syncPolicy.test.ts`:

```ts
// ── #87/#148: media pool audience validation ─────────────────────────────────

test('media INSERT: pool requires a valid audience', () => {
  const base = { entity_type: 'pool', entity_id: 'user-1', url: 'https://x/media/pool/user-1/a.jpg' };
  assert.match(validateMediaWrite('INSERT', { ...base }) ?? '', /audience/);
  assert.match(validateMediaWrite('INSERT', { ...base, audience: 'friends' }) ?? '', /audience/);
  assert.equal(validateMediaWrite('INSERT', { ...base, audience: 'team' }), null);
  assert.equal(validateMediaWrite('INSERT', { ...base, audience: 'everyone' }), null);
});

test('media INSERT: audience=users requires a JSON array of UUIDs', () => {
  const base = { entity_type: 'pool', entity_id: 'user-1', url: 'https://x/media/pool/user-1/a.jpg', audience: 'users' };
  assert.match(validateMediaWrite('INSERT', { ...base }) ?? '', /audience_user_ids/);
  assert.match(validateMediaWrite('INSERT', { ...base, audience_user_ids: '["not-a-uuid"]' }) ?? '', /audience_user_ids/);
  assert.match(validateMediaWrite('INSERT', { ...base, audience_user_ids: '{}' }) ?? '', /audience_user_ids/);
  assert.equal(validateMediaWrite('INSERT', {
    ...base, audience_user_ids: '["6f1e1c2a-9b3d-4e5f-8a7b-0c1d2e3f4a5b"]',
  }), null);
});

test('media INSERT: non-pool photos must not carry an audience', () => {
  assert.match(validateMediaWrite('INSERT', {
    entity_type: 'job', entity_id: 'job-1', url: 'https://x/media/job/job-1/a.jpg', audience: 'team',
  }) ?? '', /audience/);
});

test('media UPDATE: audience columns are immutable', () => {
  assert.match(validateMediaWrite('UPDATE', { audience: 'everyone' }) ?? '', /audience/);
  assert.match(validateMediaWrite('UPDATE', { audience_user_ids: '[]' }) ?? '', /audience/);
});

test("MEDIA_ENTITY_TYPES includes 'pool'", () => {
  assert.ok(MEDIA_ENTITY_TYPES.has('pool'));
});
```

(Adjust the `url` fixture values to whatever `validateMediaUrlField` requires — read its implementation and use a passing URL shape for the pool entity type; if it derives the expected path from entity type/id, pool URLs follow the same convention.)

- [ ] **Step 3: Run to verify failure** — `cd apps/api && pnpm test` → new tests FAIL (`'pool'` rejected as entity_type; no audience validation).

- [ ] **Step 4: Implement** in `syncPolicy.ts`:

Add `'pool'` to the set and export the audience values next to it:

```ts
export const MEDIA_ENTITY_TYPES = new Set(['item', 'equipment_unit', 'job', 'location', 'repair', 'activity_log', 'message', 'pool']);
// #87/#148: pool-share audiences. TEXT values, validated on INSERT, immutable after.
export const AUDIENCE_VALUES = new Set(['team', 'everyone', 'users']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
```

In `validateMediaWrite`, INSERT branch — after the existing url checks, before `return null`:

```ts
    const isPool = entityType === 'pool';
    const audience = payload.audience == null ? null : String(payload.audience);
    if (isPool) {
      if (audience == null || !AUDIENCE_VALUES.has(audience)) return 'media audience not allowed';
      if (audience === 'users') {
        let ids: unknown;
        try { ids = JSON.parse(String(payload.audience_user_ids)); } catch { ids = null; }
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50
          || !ids.every(v => typeof v === 'string' && UUID_RE.test(v))) {
          return 'media audience_user_ids must be a JSON array of user UUIDs';
        }
      }
    } else if (audience != null || payload.audience_user_ids != null) {
      return 'media audience only applies to pool photos';
    }
```

UPDATE branch — extend the existing url immutability check:

```ts
  if ('url' in payload || 'thumbnail_url' in payload) {
    return 'media url/thumbnail_url cannot be changed via sync';
  }
  if ('audience' in payload || 'audience_user_ids' in payload) {
    return 'media audience cannot be changed via sync';
  }
```

Note the existing UPDATE rule "media can only be moved to a job" stays — pool photos can still be reassigned to a job later (existing behavior, per spec's out-of-scope note referencing the media detail sheet).

- [ ] **Step 5: Verify + commit** — `pnpm test` green, `npx tsc --noEmit` clean.

```bash
git add src/db/migrations/064_media_audience.sql src/lib/syncPolicy.ts src/lib/syncPolicy.test.ts
git commit -m "feat(#148): media audience columns + validation, 'pool' entity type

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: API — pool pull scoping in mediaScopeSql

**Files:**
- Modify: `apps/api/src/routes/sync.ts:142-150` (`mediaScopeSql`)
- Test: `apps/api/src/routes/sync-guards.test.ts` (fixtures ~lines 32-36, media dispatcher ~lines 197-209, new tests after line 400)

**Interfaces:**
- Consumes: columns from Task 1. Produces: pool rows sync only to uploader / everyone / uploader's teammates / listed users. Both `/sync/pull` and `/sync/full` call sites pick this up automatically (they already call `mediaScopeSql`).

- [ ] **Step 1: Failing tests** — extend `MEDIA_ROWS` and the fake-pg dispatcher, add test pair. Fixtures:

```ts
const MEDIA_ROWS = [
  { id: 'media-item', entity_type: 'item', entity_id: 'item-1' },
  { id: 'media-msg-mine', entity_type: 'message', entity_id: 'msg-mine' },
  { id: 'media-msg-foreign', entity_type: 'message', entity_id: 'msg-foreign' },
  { id: 'media-pool-mine', entity_type: 'pool', uploaded_by: CALLER, audience: 'users', audience_user_ids: '["other-user"]' },
  { id: 'media-pool-everyone', entity_type: 'pool', uploaded_by: 'stranger', audience: 'everyone', audience_user_ids: null },
  { id: 'media-pool-team', entity_type: 'pool', uploaded_by: 'teammate-1', audience: 'team', audience_user_ids: null },
  { id: 'media-pool-otherteam', entity_type: 'pool', uploaded_by: 'not-my-teammate', audience: 'team', audience_user_ids: null },
  { id: 'media-pool-listed', entity_type: 'pool', uploaded_by: 'stranger', audience: 'users', audience_user_ids: `["${CALLER}"]` },
  { id: 'media-pool-notlisted', entity_type: 'pool', uploaded_by: 'stranger', audience: 'users', audience_user_ids: '["someone-else"]' },
];
```

(`CALLER` = whatever caller-id constant the harness already injects; `teammate-1` must share a team with CALLER in a `TEAM_MEMBERS` fixture — add one modeled on the file's existing fixtures, wired into the dispatcher for the `team_members` subquery detection.) Dispatcher: extend the `FROM media` branch — when the SQL includes the new pool fragment (detect `entity_type != 'pool'`), emulate: keep pool rows where `uploaded_by === uid`, or `audience === 'everyone'`, or (`audience === 'team'` and uploader shares a team with uid), or (`audience === 'users'` and `audience_user_ids` contains uid). Tests:

```ts
test('pull: pool media scoped to uploader/everyone/team/listed users', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'GET', url: '/sync/pull?since=2020-01-01T00:00:00.000Z' });
  assert.equal(res.statusCode, 200);
  const media = (res.json() as Record<string, { rows: Array<{ id: string }> }>).media.rows;
  assert.deepEqual(media.map(r => r.id).sort(),
    ['media-item', 'media-msg-mine', 'media-pool-everyone', 'media-pool-listed', 'media-pool-mine', 'media-pool-team']);
  await app.close();
});

test('full: pool media scoped identically', async () => {
  const app = await buildApp(fakePg());
  const res = await app.inject({ method: 'GET', url: '/sync/full?table=media' });
  assert.equal(res.statusCode, 200);
  const { rows } = res.json() as { rows: Array<{ id: string }> };
  assert.deepEqual(rows.map(r => r.id).sort(),
    ['media-item', 'media-msg-mine', 'media-pool-everyone', 'media-pool-listed', 'media-pool-mine', 'media-pool-team']);
  await app.close();
});
```

- [ ] **Step 2: Run to verify failure** — the two new tests fail (all pool rows returned unscoped).

- [ ] **Step 3: Implement** — replace `mediaScopeSql`:

```ts
// Media pull scoping. #29-H: message attachments are private to the message's
// conversation. #87/#148: pool shares are visible to the uploader, 'everyone'
// shares, the uploader's teammates ('team'), and listed users ('users' — the
// JSON-array LIKE is exact enough: UUIDs are fixed-form and quoted in the
// array, so no substring false positives). Other entity media stays unscoped.
function mediaScopeSql(callerParam: string): string {
  const mine = `SELECT conversation_id FROM conversation_participants WHERE user_id = ${callerParam}`;
  const myTeams = `SELECT team_id FROM team_members WHERE user_id = ${callerParam}`;
  const msg = `(entity_type != 'message' OR entity_id IN (SELECT id FROM messages WHERE conversation_id IN (${mine})))`;
  const pool = `(entity_type != 'pool' OR uploaded_by = ${callerParam} OR audience = 'everyone'
    OR (audience = 'team' AND uploaded_by IN (SELECT user_id FROM team_members WHERE team_id IN (${myTeams})))
    OR (audience = 'users' AND audience_user_ids LIKE '%' || ${callerParam} || '%'))`;
  return `(${msg} AND ${pool})`;
}
```

- [ ] **Step 4: Verify + commit** — `pnpm test` green (incl. the pre-existing message-scope pair), tsc clean.

```bash
git add src/routes/sync.ts src/routes/sync-guards.test.ts
git commit -m "feat(#87): pool media pull scoping — uploader/everyone/team/listed users

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: API — push hook on pool media INSERT

**Files:**
- Modify: `apps/api/src/lib/notifications.ts` (add `resolvePoolRecipients` + optional no-push flag on `deliver`)
- Modify: `apps/api/src/routes/sync.ts` (new hook after the messages block, ~line 1591)
- Test: `apps/api/src/lib/notifications.test.ts` (create or append, matching existing api test harness style)

**Interfaces:**
- Consumes: `deliver(pg, userIds, {type,title,body,data?,createdBy?})` (notifications.ts:72); `AUDIENCE_VALUES` from Task 1.
- Produces: `resolvePoolRecipients(pg, audience: 'team'|'users'|'everyone', audienceUserIds: unknown, senderId: string): Promise<string[]>`; `deliver` gains `push?: boolean` in its payload (default true — when false, write inbox rows but skip `sendPush`).

- [ ] **Step 1: Read `deliver()`'s body** in `lib/notifications.ts` to locate its `sendPush` call, then **write failing tests** for the resolver (pure parts exercised with a stub pg; follow the file's existing test conventions — if no notifications.test.ts exists, model the stub on `sync-guards.test.ts`'s fakePg):

```ts
test('resolvePoolRecipients: users audience → parsed ids minus sender', async () => {
  const ids = await resolvePoolRecipients(stubPg(), 'users',
    `["${U1}", "${U2}", "${SENDER}"]`, SENDER);
  assert.deepEqual(ids.sort(), [U1, U2].sort());
});

test('resolvePoolRecipients: garbage audience_user_ids → empty', async () => {
  assert.deepEqual(await resolvePoolRecipients(stubPg(), 'users', 'not-json', SENDER), []);
  assert.deepEqual(await resolvePoolRecipients(stubPg(), 'users', null, SENDER), []);
});

test('resolvePoolRecipients: team audience → active teammates minus sender', async () => {
  // stubPg returns TEAMMATE rows for the team_members join
  const ids = await resolvePoolRecipients(stubPgWithTeam([SENDER, TEAMMATE]), 'team', null, SENDER);
  assert.deepEqual(ids, [TEAMMATE]);
});

test('resolvePoolRecipients: everyone → empty (inbox handled separately, no push targeting)', async () => {
  assert.deepEqual(await resolvePoolRecipients(stubPg(), 'everyone', null, SENDER), []);
});
```

- [ ] **Step 2: Run to verify failure**, then **implement** in `lib/notifications.ts`:

```ts
// #87: recipients for a pool photo share. 'users' → the listed ids; 'team' →
// active members of every team the sender is on; 'everyone' → [] (everyone-
// shares are deliberately quiet: media hub + scope SQL carry them, no blast).
// Sender always excluded.
export async function resolvePoolRecipients(
  pg: Pg,
  audience: 'team' | 'users' | 'everyone',
  audienceUserIds: unknown,
  senderId: string,
): Promise<string[]> {
  const ids = new Set<string>();
  if (audience === 'users') {
    try {
      const parsed = JSON.parse(String(audienceUserIds));
      if (Array.isArray(parsed)) parsed.forEach(v => { if (typeof v === 'string') ids.add(v); });
    } catch { /* malformed → no recipients */ }
  } else if (audience === 'team') {
    (await pg.query(
      `SELECT DISTINCT tm.user_id FROM team_members tm
         JOIN users u ON u.id = tm.user_id AND u.active = TRUE
        WHERE tm.team_id IN (SELECT team_id FROM team_members WHERE user_id = $1)`,
      [senderId],
    )).rows.forEach(r => ids.add(r.user_id as string));
  }
  ids.delete(senderId);
  return [...ids];
}
```

And thread `push?: boolean` through `deliver`'s payload type, gating its internal `sendPush` call with `if (p.push !== false)` (inbox insert unchanged).

- [ ] **Step 3: The sync.ts hook** — insert directly after the messages-INSERT block (after line ~1591, same `try`, after `ok.push`), same fire-and-forget shape:

```ts
        // #87: pool photo share → notify the audience. users/team push+inbox;
        // 'everyone' inbox-only for ALL active users (no company-wide push
        // blast). Fire-and-forget: never blocks or fails the sync write.
        if (entry.table_name === 'media' && entry.operation === 'INSERT'
          && entry.payload.entity_type === 'pool') {
          const aud = String(entry.payload.audience ?? '');
          const mediaId = String(entry.payload.id ?? '');
          const note = typeof entry.payload.location_note === 'string' && entry.payload.location_note.trim()
            ? entry.payload.location_note.trim() : null;
          const audienceUserIds = entry.payload.audience_user_ids;
          void (async () => {
            try {
              let recipients: string[];
              let push = true;
              if (aud === 'everyone') {
                recipients = (await fastify.pg.query(
                  `SELECT id FROM users WHERE active = TRUE AND id != $1`, [userId],
                )).rows.map(r => r.id as string);
                push = false;
              } else if (aud === 'team' || aud === 'users') {
                recipients = await resolvePoolRecipients(fastify.pg, aud, audienceUserIds, userId);
              } else return;
              if (!recipients.length || !mediaId) return;
              const { rows: uRows } = await fastify.pg.query(`SELECT name FROM users WHERE id = $1`, [userId]);
              const senderName = uRows[0] ? String((uRows[0] as { name: string }).name) : 'Photo shared';
              await deliver(fastify.pg, recipients, {
                type: 'media_share',
                title: senderName,
                body: note ? `Shared a photo — ${note}` : 'Shared a photo',
                data: { screen: 'media', id: mediaId },
                createdBy: userId,
                push,
              });
            } catch { /* never disrupt sync */ }
          })();
        }
```

Import `resolvePoolRecipients` alongside the existing notifications imports in sync.ts.

- [ ] **Step 4: Verify + commit** — `pnpm test` green, tsc clean.

```bash
git add src/lib/notifications.ts src/lib/notifications.test.ts src/routes/sync.ts
git commit -m "feat(#87): push hook on pool media INSERT via deliver(), everyone inbox-only

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Mobile — migration 052, pull columns, uploadCore plumbing

**Files:**
- Create: `apps/mobile/src/db/migrations/052_media_audience.ts`
- Modify: `apps/mobile/src/db/schema.ts:135-138` and `apps/mobile/src/db/schema.web.ts:159-163` (register 052 in BOTH arrays)
- Modify: `apps/mobile/src/sync/pull.ts:17` (TABLE_UPSERT_SQL media) and `:53` (rowToValues media)
- Modify: `apps/mobile/src/media/uploadCore.ts` (UploadMediaInput + insertMediaRow)
- Test: `apps/mobile/src/media/uploadCore.test.ts` (create, standard Module._load harness copied from `src/db/queries/vehiclesLock.test.ts`, stubbing `../db/schema` → testdb; also stub `../auth/session`/telemetry as the harness pattern requires — check uploadCore's import graph and stub what fails to load)

**Interfaces:**
- Produces: `UploadMediaInput` gains `caption?: string | null; audience?: 'team' | 'everyone' | 'users' | null; audienceUserIds?: string[] | null;` — `insertMediaRow` writes + outboxes `caption`, `audience`, `audience_user_ids` (audience columns null unless entityType==='pool'). Task 6 calls `uploadMediaAsset` with these.

- [ ] **Step 1: Migration**:

```ts
import type { SqlDb } from '../types';

// Migration 052: media pool-share audience (#87/#148). Mirrors API 064.
// SYNCED columns (docs/SYNC-MIGRATION-CHECKLIST.md): pull.ts TABLE_UPSERT_SQL
// + rowToValues extended in the same change. audience 'team'|'everyone'|'users'
// (TEXT); audience_user_ids JSON array of user UUIDs (TEXT). NULL = job/entity
// photo.
export const migration = {
  version: 52,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE media ADD COLUMN audience TEXT`);
    db.executeSync(`ALTER TABLE media ADD COLUMN audience_user_ids TEXT`);
  },
};
```

Register in `schema.ts` (import + array entry after m051) AND `schema.web.ts` (add `import('./migrations/052_media_audience'),` after the 051 line). Both files, same change — web has its OWN array.

- [ ] **Step 2: pull.ts** — extend the media upsert (append the two columns + two placeholders) and rowToValues:

```ts
  media: `INSERT OR REPLACE INTO media (id, entity_type, entity_id, media_type, url, thumbnail_url, caption, is_primary, uploaded_by, created_at, location_note, updated_at, audience, audience_user_ids) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
```

```ts
    case 'media': return [row.id, row.entity_type, row.entity_id, row.media_type, row.url, row.thumbnail_url ?? null, row.caption ?? null, row.is_primary ? 1 : 0, row.uploaded_by ?? null, row.created_at, row.location_note ?? null, row.updated_at ?? row.created_at, row.audience ?? null, row.audience_user_ids ?? null];
```

Run `node --import tsx --import ./src/test/setupGlobals.mjs --test src/sync/pullColumns.test.ts` — parity test passes (14 cols / 14 placeholders / 14 values).

- [ ] **Step 3: uploadCore failing tests** — `insertMediaRow` with the new fields (harness: create the media table in `before()` with all 14 columns as TEXT/INTEGER, matching migration 022+036+052 shape; create `outbox` if testdb doesn't):

```ts
test('insertMediaRow: pool share writes audience columns + caption and outboxes them', () => {
  const out = core.insertMediaRow({
    entityType: 'pool', entityId: 'user-1', mediaType: 'image', ext: 'jpg',
    userId: 'user-1', locationNote: 'Kitchen', caption: 'ceiling stain',
    audience: 'users', audienceUserIds: ['6f1e1c2a-9b3d-4e5f-8a7b-0c1d2e3f4a5b'],
  }, 'https://x/pool/a.jpg');
  const row = rowsAs(db.executeSync(`SELECT * FROM media WHERE id = ?`, [out.id]).rows)[0];
  assert.equal(row.audience, 'users');
  assert.equal(row.caption, 'ceiling stain');
  assert.equal(JSON.parse(row.audience_user_ids)[0], '6f1e1c2a-9b3d-4e5f-8a7b-0c1d2e3f4a5b');
  const ob = rowsAs(db.executeSync(`SELECT payload FROM outbox ORDER BY rowid DESC LIMIT 1`).rows)[0];
  const payload = JSON.parse(ob.payload);
  assert.equal(payload.audience, 'users');
  assert.equal(payload.caption, 'ceiling stain');
});

test('insertMediaRow: job photo leaves audience columns null (unchanged path)', () => {
  const out = core.insertMediaRow({
    entityType: 'job', entityId: 'job-1', mediaType: 'image', ext: 'jpg',
    userId: 'user-1', locationNote: null,
  }, 'https://x/job/a.jpg');
  const row = rowsAs(db.executeSync(`SELECT audience, audience_user_ids, caption FROM media WHERE id = ?`, [out.id]).rows)[0];
  assert.equal(row.audience, null);
  assert.equal(row.audience_user_ids, null);
  assert.equal(row.caption, null);
});
```

(Adapt `rowsAs`/outbox column names to what the harness/testdb actually provides — read `src/sync/outbox.ts` for the outbox table shape; if `appendOutbox` routes through `db/tx.ts` bumps, the harness may need the same stubs vehiclesLock uses.)

- [ ] **Step 4: Implement uploadCore** — extend the interface:

```ts
export interface UploadMediaInput {
  entityType: string;
  entityId: string;
  mediaType: 'image' | 'video';
  ext: string;
  uri?: string;
  file?: File;
  size?: number;
  userId: string;
  locationNote?: string | null;
  caption?: string | null;              // #148: optional note
  audience?: 'team' | 'everyone' | 'users' | null;   // #87: pool shares only
  audienceUserIds?: string[] | null;    // #87: when audience === 'users'
}
```

And `insertMediaRow` — bind caption + audience columns (audience only for pool):

```ts
export function insertMediaRow(input: UploadMediaInput, publicUrl: string): UploadedMedia {
  const existing = getMediaForEntity(input.entityType, input.entityId);
  const isPrimary = existing.length === 0;
  const id = generateUUID();
  const now = new Date().toISOString();
  const locationNote = input.locationNote ?? null;
  const caption = input.caption ?? null;
  const isPool = input.entityType === 'pool';
  const audience = isPool ? input.audience ?? null : null;
  const audienceUserIds = isPool && input.audience === 'users' && input.audienceUserIds?.length
    ? JSON.stringify(input.audienceUserIds) : null;

  const db = getDb();
  db.executeSync(
    `INSERT OR REPLACE INTO media (id, entity_type, entity_id, media_type, url, thumbnail_url, caption, location_note, is_primary, uploaded_by, created_at, updated_at, audience, audience_user_ids)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.entityType, input.entityId, input.mediaType, publicUrl, caption, locationNote, isPrimary ? 1 : 0, input.userId, now, now, audience, audienceUserIds]
  );

  appendOutbox('INSERT', 'media', {
    id,
    entity_type: input.entityType,
    entity_id: input.entityId,
    media_type: input.mediaType,
    url: publicUrl,
    caption,
    location_note: locationNote,
    is_primary: isPrimary,
    uploaded_by: input.userId,
    created_at: now,
    ...(audience ? { audience } : {}),
    ...(audienceUserIds ? { audience_user_ids: audienceUserIds } : {}),
  });

  return { id, url: publicUrl };
}
```

- [ ] **Step 5: Verify + commit** — single-file test green, then full `pnpm test` + `npx tsc --noEmit` from apps/mobile.

```bash
git add src/db/migrations/052_media_audience.ts src/db/schema.ts src/db/schema.web.ts src/sync/pull.ts src/media/uploadCore.ts src/media/uploadCore.test.ts
git commit -m "feat(#148): mobile media audience columns — migration 052, pull parity, uploadCore

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Mobile — quickPhotoLogic pure state machine

**Files:**
- Create: `apps/mobile/src/components/quickphoto/quickPhotoLogic.ts`
- Test: `apps/mobile/src/components/quickphoto/quickPhotoLogic.test.ts` (plain node:test — pure module, no DB harness needed)

**Interfaces:**
- Produces (Task 6 consumes verbatim):

```ts
export type QuickPhotoDest =
  | { kind: 'job'; jobId: string; jobName: string }
  | { kind: 'pool'; audience: 'team' | 'everyone' | 'users'; userIds: string[] };
export type QuickPhotoPhase = 'closed' | 'destination' | 'camera' | 'details';
export interface QuickPhotoState { phase: QuickPhotoPhase; dest: QuickPhotoDest | null; photoUri: string | null; }
export function initialState(): QuickPhotoState;
export function open(s: QuickPhotoState): QuickPhotoState;                     // closed → destination
export function chooseDest(s: QuickPhotoState, dest: QuickPhotoDest): QuickPhotoState; // destination → camera
export function photoTaken(s: QuickPhotoState, uri: string): QuickPhotoState;  // camera → details
export function cameraCancelled(s: QuickPhotoState): QuickPhotoState;          // camera → closed
export function saveDone(s: QuickPhotoState): QuickPhotoState;                 // details → closed
export function saveAndAddAnother(s: QuickPhotoState): QuickPhotoState;        // details → camera, dest KEPT
export function cancelDetails(s: QuickPhotoState): QuickPhotoState;            // details → closed (photo discarded)
export function buildUploadInput(
  dest: QuickPhotoDest, userId: string, roomArea: string, note: string,
): { entityType: string; entityId: string; locationNote: string | null; caption: string | null;
     audience: 'team' | 'everyone' | 'users' | null; audienceUserIds: string[] | null };
```

- [ ] **Step 1: Failing tests** — cover: full happy path job (open → chooseDest job → photoTaken → saveDone ends closed); pool users path; save-&-add-another keeps dest and returns to camera with photoUri cleared; cameraCancelled/cancelDetails reset to closed with dest/photo nulled; buildUploadInput: job dest → `{entityType:'job', entityId:jobId, audience:null, audienceUserIds:null}`; pool team → `{entityType:'pool', entityId:userId, audience:'team', audienceUserIds:null}`; pool users → audienceUserIds passed through; empty roomArea/note strings → null fields (trimmed).

```ts
test('save & add another keeps destination, clears photo, returns to camera', () => {
  let s = open(initialState());
  s = chooseDest(s, { kind: 'pool', audience: 'team', userIds: [] });
  s = photoTaken(s, 'file://a.jpg');
  s = saveAndAddAnother(s);
  assert.equal(s.phase, 'camera');
  assert.deepEqual(s.dest, { kind: 'pool', audience: 'team', userIds: [] });
  assert.equal(s.photoUri, null);
});

test('buildUploadInput: pool users share', () => {
  const r = buildUploadInput({ kind: 'pool', audience: 'users', userIds: ['u2'] }, 'u1', ' Kitchen ', '');
  assert.deepEqual(r, {
    entityType: 'pool', entityId: 'u1', locationNote: 'Kitchen', caption: null,
    audience: 'users', audienceUserIds: ['u2'],
  });
});
```

(Write the full suite — every transition and every buildUploadInput branch above; each is 3-6 lines in this style.)

- [ ] **Step 2: Verify failure, implement** — plain pure functions returning new state objects; invalid-phase calls return the state unchanged (e.g. `photoTaken` in phase 'closed' is a no-op). `buildUploadInput` trims roomArea/note, maps empty→null, audience fields null for job dests, `audienceUserIds` only for `audience==='users'` with non-empty list (else null).

- [ ] **Step 3: Verify + commit**:

```bash
git add src/components/quickphoto/quickPhotoLogic.ts src/components/quickphoto/quickPhotoLogic.test.ts
git commit -m "feat(#148): quick-photo flow state machine (pure)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Mobile — QuickPhoto UI (host, button, flow) + suggestions

**Files:**
- Create: `apps/mobile/src/components/quickphoto/QuickPhotoFlow.tsx` (host + sheets)
- Modify: `apps/mobile/app/(app)/_layout.tsx` (camera button in headerRight before `<ChatBell />`; mount `<QuickPhotoFlow />` as a sibling of the Stack in this layout's returned tree)
- Modify: `apps/mobile/src/db/queries/media.ts:77-86` (suggestions: add pool variant)
- No unit tests (UI); logic is Task 5's. Verify: tsc + full suite + device.

**Interfaces:**
- Consumes: Task 5's exports; `uploadMediaAsset` (`src/media/upload.ts`) with Task 4's fields; `ImagePicker.launchCameraAsync` idiom from `MediaGallery.handleCamera` (`MediaGallery.tsx:97-113` — permission alert, `mediaTypes: ['images'], quality: 0.85, allowsEditing: false`); `SearchablePicker` (+`PickerOption`) with `getOpenJobs()` mapped exactly as `(checkout)/index.tsx:178-185` does; `getAllActiveUsers()` (`queries/users.ts:56`) for the specific-users multi-select; `ModalSheet` / `confirmSheet` / `Toast` idioms; `SuggestInput` + note-sheet layout from `MediaGallery.tsx:204-222`.
- Produces: module-level `openQuickPhoto(): void` exported from QuickPhotoFlow.tsx (the header button calls it) — same host pattern as `confirmSheet`/ConfirmSheetHost (module-level trigger + singleton mounted component; copy the mechanism from `src/components/ui/ConfirmSheet.tsx`).

- [ ] **Step 1: suggestions query** — in `queries/media.ts`, add below `getLocationNoteSuggestions`:

```ts
// #148: Room/Area suggestions for pool quick-photos — the uploader's own past
// pool notes (job flow keeps the job-scoped variant above).
export function getPoolLocationNoteSuggestions(userId: string): string[] {
  const db = getDb();
  const result = db.executeSync(
    `SELECT location_note, MAX(updated_at) AS last_used FROM media
     WHERE entity_type = 'pool' AND uploaded_by = ? AND location_note IS NOT NULL AND TRIM(location_note) != ''
     GROUP BY location_note ORDER BY last_used DESC LIMIT 8`,
    [userId]
  );
  return (result.rows as unknown as { location_note: string }[]).map(r => r.location_note);
}
```

- [ ] **Step 2: QuickPhotoFlow.tsx** — one file, four pieces:
  1. Module trigger: `let openFn: (() => void) | null = null; export function openQuickPhoto() { openFn?.(); }` registered by the host on mount (ConfirmSheet's exact mechanism).
  2. Destination sheet (`ModalSheet`, phase 'destination'): "For a job?" — `SearchablePicker` over `getOpenJobs()` options; below it the audience row: three selectable pills (My team / Everyone / Specific users — reuse `StatusPill` inside `Pressable`s, the VehicleEditSheet toggle idiom); choosing "Specific users" reveals a checkbox list of `getAllActiveUsers()` (excluding self) with a Done button. Selecting a job or an audience calls `chooseDest` and advances.
  3. Camera step (phase 'camera'): a `useEffect` that fires the `handleCamera` idiom (permission → `launchCameraAsync` → `photoTaken(uri)` or `cameraCancelled()`); no UI of its own.
  4. Details sheet (`ModalSheet`, phase 'details'): Room/Area `SuggestInput` (autoFocus; suggestions = job dest ? `getLocationNoteSuggestions(jobId)` : `getPoolLocationNoteSuggestions(user.id)`), Note `AppInput`, buttons Done / Save & add another / Cancel. Done and Save-&-add-another both: `buildUploadInput(...)` → `uploadMediaAsset({ ...built, mediaType: 'image', ext: 'jpg', uri: photoUri, userId: user.id })` inside try/catch (Toast on `MediaTooLargeError`/failure; note: `uploadMediaAsset` requires connectivity for the presign — surface its thrown error as a Toast, do not crash the sheet); then `saveDone`/`saveAndAddAnother`. Cancel: if either field is dirty, `confirmSheet({ title: 'Discard photo?', destructive: true })` first, then `cancelDetails`.

- [ ] **Step 3: header button** — in `(app)/_layout.tsx` headerRight, before `<ChatBell />`:

```tsx
              <TouchableOpacity style={styles.switchBtn} onPress={openQuickPhoto} hitSlop={8}>
                <Text style={styles.switchText}>📷</Text>
              </TouchableOpacity>
```

(Reuse the existing switchBtn styling; per the #148 spec's header-restyle note, ONLY add the camera — the Switch-button icon restyle is deferred, it's cosmetic and not needed for #87.) Mount `<QuickPhotoFlow />` after `<Stack>` in the same layout component.

- [ ] **Step 4: Verify + commit** — `npx tsc --noEmit` clean, `pnpm test` green.

```bash
git add src/components/quickphoto/QuickPhotoFlow.tsx "app/(app)/_layout.tsx" src/db/queries/media.ts
git commit -m "feat(#148): header quick-photo capture flow — job or audience pool

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Mobile — deep-link to the photo + pool visibility in the hub

**Files:**
- Modify: `apps/mobile/src/push/handlers.ts:22-54` (add 'media' case)
- Modify: `apps/mobile/app/(app)/(notifications)/index.tsx:139-156` (add 'media' case to its local `navigateTo`)
- Modify: `apps/mobile/app/(app)/(media)/index.tsx` (accept `id` param → open `MediaDetailSheet`; pool photos surface + "Shared" filter chip)

**Interfaces:**
- Consumes: `syncNow()` (`src/sync/engine.ts:282`); `MediaDetailSheet` + `selectedId` state already in the media screen; a `getMediaById(id)` query — check `queries/media.ts`, add a trivial `SELECT * FROM media WHERE id = ?` helper if absent.

- [ ] **Step 1: handlers.ts** — new case in the switch (before `notifications`):

```ts
    case 'media':
      // #87: pool photo share — open the media hub on the shared photo.
      if (id) router.push({ pathname: '/(app)/(media)', params: { id } });
      else router.push('/(app)/(media)');
      return;
```

Same case added to the notifications screen's local `navigateTo` switch (`if (id) router.push({ pathname: '/(app)/(media)', params: { id } });`).

- [ ] **Step 2: media hub param handling** — in `(media)/index.tsx`:

```tsx
  const { id: linkedId } = useLocalSearchParams<{ id?: string }>();
  // #87: push/inbox deep-link → open the photo. The push can beat the pull:
  // if the row isn't local yet, trigger a sync; the version-bump refresh
  // re-runs this effect and the sheet opens when the row lands.
  useEffect(() => {
    if (!linkedId) return;
    if (getMediaById(linkedId)) { setSelectedId(linkedId); return; }
    void syncNow();
  }, [linkedId, refreshKey]);
```

(`refreshKey` = whatever reactive key the screen already uses — `useTableVersion(['media'])` / `useFocusOrDataRefresh`; read the file and reuse its existing one. Verify `MediaDetailSheet` handles a mediaId whose row vanished — it already takes `mediaId: string | null`.)

- [ ] **Step 3: pool photos in the hub** — read how the screen windows/filters media rows (its `reloadWindow`/query). Ensure `entity_type='pool'` rows are included in the browse query, and add one filter chip "Shared" (matching the screen's existing chip/filter idiom) that narrows to `entity_type = 'pool'`. Keep it minimal per the #148 spec — no audience-editing UI.

- [ ] **Step 4: Verify + commit** — tsc clean, `pnpm test` green.

```bash
git add src/push/handlers.ts "app/(app)/(notifications)/index.tsx" "app/(app)/(media)/index.tsx" src/db/queries/media.ts
git commit -m "feat(#87): media deep-link case + pool photos in the hub with Shared filter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(`queries/media.ts` only if `getMediaById` was added.)

---

### Task 8: End-to-end verification + ship

- [ ] **Step 1:** Full suites both packages + tsc both packages — all green.
- [ ] **Step 2 (controller/user):** Hotload on the S24 (Metro already serves this checkout; cold-relaunch). BUT the push half needs the API deployed: propose the **deploy-api** run to the user (VPS VM 192.168.1.72 — migration 064 applies on boot) BEFORE the two-device test.
- [ ] **Step 3 (user, two logins — S24 + web or second device):** share to a specific user → push lands → tap → photo opens in MediaDetailSheet; share to team → teammates pushed; share to everyone → NO push, photo appears in hub (Shared chip) + inbox entry; job photo via the same flow → lands in job gallery, no push; offline capture → row + outbox written, sync retries (presign requires connectivity — verify the Toast, not a crash).
- [ ] **Step 4:** On user confirmation: `gh_done.py 87` and `gh_done.py 148`; merge branch to main; push.

## Self-Review

- Spec coverage: capture flow (T5/T6), data model + both migrations + sync parity (T1/T4), scoping (T2), push + everyone-inbox (T3), deep-link + race guard + hub surfacing (T7), deploy + device (T8). Header-restyle from the #148 spec is explicitly deferred in T6 (cosmetic; noted in the task).
- Placeholders: none — every code step carries real code; the three "read the file and reuse its idiom" spots (url fixture in T1, outbox shape in T4, media-hub filter in T7) name the exact file+lines to read and what to extract.
- Type consistency: `UploadMediaInput` fields (T4) match `buildUploadInput`'s return mapping (T5) and the call in T6; `data: { screen: 'media', id }` (T3) matches the handler case (T7); `AUDIENCE_VALUES` strings match everywhere.
