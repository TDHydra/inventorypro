import { DB } from '@op-engineering/op-sqlite';

// Migration 021: one-time cleanup of duplicate (category,label) taxonomy_types
// rows. The table has no UNIQUE(category,label) constraint and sync pull is
// upsert-only (it never deletes), so duplicates created on any device — e.g. two
// 'job' rows both labeled "Mold" — persist locally and cause React duplicate-key
// warnings. Keep the lowest sort_order per (category,label), tie-broken by oldest
// updated_at, then by id; delete the rest. Pure local cleanup (no outbox): prod is
// deduped by API migration 024, and addTaxonomyType now guards against new dupes.
export const migration = {
  version: 21,
  up: (db: DB): void => {
    db.executeSync(`
      DELETE FROM taxonomy_types
      WHERE id NOT IN (
        SELECT keep_id FROM (
          SELECT id AS keep_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY category, label
                   ORDER BY sort_order ASC, updated_at ASC, id ASC
                 ) AS rn
          FROM taxonomy_types
        )
        WHERE rn = 1
      )
    `);
  },
};
