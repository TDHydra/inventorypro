# /inv-migrate — Run Database Migrations

Use this skill when you need to apply schema changes to Postgres (server) and/or SQLite (mobile). Always run both in sync — they must stay at the same schema version.

## Creating a new migration

### 1. Pick the next version number

```bash
ls apps/api/src/db/migrations/
# Highest number + 1 is your version
# e.g., if 005_add_teams.sql exists → next is 006_your_change.sql
```

### 2. Create both migration files

**Postgres:** `apps/api/src/db/migrations/<NNN>_<description>.sql`
```sql
-- Migration NNN: <description>
-- Authored: YYYY-MM-DD

-- Your SQL here
ALTER TABLE inventory_items ADD COLUMN tags TEXT[] DEFAULT '{}';

-- Always update the schema_migrations table (handled automatically by the runner)
```

**SQLite (mobile):** `apps/mobile/src/db/migrations/<NNN>_<description>.ts`
```typescript
import { OPSQLiteConnection } from '@op-engineering/op-sqlite';

export const version = <NNN>;

export const up = (db: OPSQLiteConnection): void => {
  // Mirror the Postgres change in SQLite syntax
  db.execute(`ALTER TABLE inventory_items ADD COLUMN tags TEXT DEFAULT '[]'`);
  // Note: SQLite uses JSON text for arrays, not native array type
};

export const down = (db: OPSQLiteConnection): void => {
  // SQLite doesn't support DROP COLUMN in older versions
  // For rollback, recreate the table without the column
  // Usually leave empty and handle rollback manually
};
```

### 3. SQLite syntax differences from Postgres

| Postgres | SQLite equivalent |
|---|---|
| `UUID` | `TEXT` |
| `TIMESTAMPTZ` | `TEXT` (ISO8601 string) |
| `BOOLEAN` | `INTEGER` (0/1) |
| `DECIMAL(10,3)` | `REAL` |
| `JSONB` | `TEXT` (JSON string) |
| `TEXT[]` | `TEXT` (JSON array string) |
| `ENUM type` | `TEXT` with CHECK constraint |
| `gen_random_uuid()` | Generated in app code |
| `DEFAULT NOW()` | `DEFAULT (datetime('now'))` |

## Running migrations

### Postgres (server)
```bash
# From monorepo root:
pnpm db:migrate

# Or directly:
cd ~/inventorypro/apps/api && npx tsx src/db/migrate.ts

# With Docker Compose running:
docker compose -f infra/docker-compose.yml exec api node dist/db/migrate.js
```

### SQLite (mobile)
Migrations run automatically on app start via `apps/mobile/src/db/schema.ts`. The migration runner:
1. Reads `app_settings.schema_version` from the local DB
2. Finds all migration files with version > current
3. Applies them in order within a transaction
4. Updates `schema_version`

To force re-run from scratch (dev only):
```typescript
// In Metro debug console:
import { resetLocalDb } from './src/db/schema';
await resetLocalDb(); // drops and recreates all tables
```

## Verifying migrations

After applying:
```bash
# Postgres — check schema_migrations table:
docker compose -f infra/docker-compose.yml exec postgres \
  psql -U inventorypro -c "SELECT * FROM schema_migrations ORDER BY version;"

# SQLite — check version in app:
# App logs schema_version on startup: "SQLite schema v<N> ready"
```

## Migration runner (how it works)

File: `apps/api/src/db/migrate.ts`

```
1. Connect to Postgres
2. CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ)
3. Read all .sql files from migrations/ sorted by version number
4. For each file where version NOT IN schema_migrations:
   a. BEGIN transaction
   b. Execute the SQL
   c. INSERT INTO schema_migrations (version, applied_at) VALUES (N, NOW())
   d. COMMIT (or ROLLBACK on error)
5. Log result
```

## Emergency rollback

There is no automated down migration — schema changes are always forward-only in production. To rollback:

1. Identify the last good migration version
2. Write a new migration that undoes the change (e.g., `DROP COLUMN`, recreate table)
3. Apply it as the next migration version
4. Deploy

Never manually edit `schema_migrations` or `app_settings.schema_version` to fake a rollback — this will corrupt the migration state.
