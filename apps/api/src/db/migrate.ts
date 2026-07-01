import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';

export async function runMigrations(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL env var required');

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows: applied } = await client.query<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version'
    );
    const appliedVersions = new Set(applied.map(r => r.version));

    const migrationsDir = join(__dirname, 'migrations');
    const files = readdirSync(migrationsDir)
      .filter(f => f.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const file of files) {
      const version = parseInt(file.split('_')[0], 10);
      if (appliedVersions.has(version)) continue;

      console.log(`Applying migration ${file}...`);
      const sql = readFileSync(join(migrationsDir, file), 'utf-8');

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
          [version]
        );
        await client.query('COMMIT');
        ran++;
        console.log(`  ✓ Migration ${version} applied`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }

    if (ran === 0) {
      console.log('All migrations already applied.');
    } else {
      console.log(`✓ ${ran} migration(s) applied.`);
    }

    // Prune the sync dedup table: processed_outbox rows only matter inside the
    // push-retry window, so anything older than 7 days is safe to drop. Runs on
    // every boot (after migration 013 has created the table).
    const pruned = await client.query(
      `DELETE FROM processed_outbox WHERE processed_at < NOW() - INTERVAL '7 days'`
    );
    if (pruned.rowCount) {
      console.log(`✓ Pruned ${pruned.rowCount} stale processed_outbox row(s).`);
    }

    // Prune telemetry_events: lossy-by-design behavioral sink, retained 90 days
    // (see migration 029). Runs on every boot alongside the other dedup prunes.
    const prunedTel = await client.query(
      `DELETE FROM telemetry_events WHERE received_at < NOW() - INTERVAL '90 days'`
    );
    if (prunedTel.rowCount) {
      console.log(`✓ Pruned ${prunedTel.rowCount} stale telemetry_events row(s).`);
    }
  } finally {
    await client.end();
  }
}

// Allow running directly: npx ts-node src/db/migrate.ts
if (require.main === module) {
  runMigrations().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
  });
}
