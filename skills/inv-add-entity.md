# /inv-add-entity — Add a New Trackable Entity

Use this skill when you need a new entity that needs: database storage, API routes, media attachments, and activity logging.
Provide: entity name (singular, snake_case), fields, and which roles can CRUD it.

## Steps

### 1. Postgres migration

File: `apps/api/src/db/migrations/<next_number>_create_<entity>.sql`

```sql
CREATE TABLE <entities> (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- your fields here
  created_by  UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Index for sync pull queries
CREATE INDEX <entities>_updated_at_idx ON <entities>(updated_at);
```

### 2. SQLite migration (mobile)

File: `apps/mobile/src/db/migrations/<same_number>_create_<entity>.ts`

```typescript
export const up = (db: OPSQLiteConnection) => {
  db.execute(`
    CREATE TABLE IF NOT EXISTS <entities> (
      id          TEXT PRIMARY KEY,
      -- your fields
      created_by  TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      synced_at   TEXT
    )
  `);
  db.execute(`CREATE INDEX IF NOT EXISTS <entities>_updated_at ON <entities>(updated_at)`);
};
```

### 3. Register entity in sync engine

File: `apps/mobile/src/sync/pull.ts`

Add to the `SYNC_TABLES` array:
```typescript
{ table: '<entities>', orderBy: 'updated_at' },
```

File: `apps/api/src/routes/sync.ts`

Add to the pull query builder:
```typescript
case '<entities>':
  rows = await db.query(
    'SELECT * FROM <entities> WHERE updated_at > $1 ORDER BY updated_at',
    [since]
  );
```

### 4. Fastify routes

File: `apps/api/src/routes/<entities>.ts`

```typescript
import { FastifyPluginAsync } from 'fastify';

const routes: FastifyPluginAsync = async (fastify) => {
  // GET /entities — list
  fastify.get('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { rows } = await fastify.pg.query('SELECT * FROM <entities> ORDER BY created_at DESC');
    return rows;
  });

  // POST /entities — create
  fastify.post('/', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    // validate body, check permission, insert, log activity
    const { rows } = await fastify.pg.query(
      'INSERT INTO <entities> (...) VALUES (...) RETURNING *',
      [...]
    );
    // log to activity_log
    await fastify.pg.query(
      `INSERT INTO activity_log (id, user_id, action, entity_type, entity_id, created_at, synced_at)
       VALUES (gen_random_uuid(), $1, '<entity>_created', '<entity>', $2, NOW(), NOW())`,
      [req.user.id, rows[0].id]
    );
    return reply.status(201).send(rows[0]);
  });

  // PATCH /entities/:id — update
  fastify.patch('/:id', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    // validate, check permission, update, log
  });
};

export default routes;
```

Register in `apps/api/src/index.ts`:
```typescript
fastify.register(entityRoutes, { prefix: '/<entities>' });
```

### 5. SQLite query functions (mobile)

File: `apps/mobile/src/db/queries/<entities>.ts`

```typescript
import { getDb } from '../schema';

export function getAll<Entity>(): <Entity>[] {
  const db = getDb();
  const result = db.execute('SELECT * FROM <entities> ORDER BY created_at DESC');
  return result.rows._array as <Entity>[];
}

export function getById(id: string): <Entity> | null {
  const db = getDb();
  const result = db.execute('SELECT * FROM <entities> WHERE id = ?', [id]);
  return (result.rows._array[0] as <Entity>) ?? null;
}

export function upsert<Entity>(entity: <Entity>): void {
  const db = getDb();
  db.execute(
    `INSERT OR REPLACE INTO <entities> (...) VALUES (...)`,
    [...]
  );
}
```

### 6. Hook (mobile)

File: `apps/mobile/src/hooks/use<Entities>.ts`

```typescript
import { useState, useEffect, useCallback } from 'react';
import { getAll<Entity>, upsert<Entity> } from '../db/queries/<entities>';
import { appendOutbox } from '../sync/outbox';
import { generateUUID } from '../utils/uuid';

export function use<Entities>() {
  const [items, setItems] = useState<Entity[]>([]);

  const refresh = useCallback(() => {
    setItems(getAll<Entity>());
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const create = useCallback((data: Omit<<Entity>, 'id' | 'created_at' | 'updated_at'>) => {
    const entity = { ...data, id: generateUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    upsert<Entity>(entity);
    appendOutbox({ operation: 'INSERT', table_name: '<entities>', payload: entity });
    refresh();
  }, [refresh]);

  return { items, create, refresh };
}
```

### 7. Add media support

In `apps/mobile/src/components/MediaGallery.tsx`, the `entityType` prop accepts any string matching `media.entity_type`. No code change needed — just pass `entity_type: '<entity>'` when uploading.

### 8. Add activity log actions

File: `apps/mobile/src/constants/logActions.ts`

```typescript
export const LOG_ACTIONS = {
  // ... existing
  '<entity>_created': '<Entity> Created',
  '<entity>_updated': '<Entity> Updated',
  '<entity>_deleted': '<Entity> Deleted',
} as const;
```

### 9. Verify

- [ ] Postgres migration runs cleanly (`pnpm db:migrate`)
- [ ] SQLite migration applies on app start
- [ ] Create via API returns 201 with correct shape
- [ ] Sync pull includes new entity in paginated response
- [ ] Mobile create writes to outbox and updates local state
- [ ] After outbox drains, server has the record
- [ ] Media can be attached (`entity_type: '<entity>'`)
- [ ] Activity log entry written on create/update
