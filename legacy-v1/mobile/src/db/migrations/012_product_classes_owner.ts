import type { SqlDb } from '../types';

// Fixed seed UUIDs for the 4 legacy measurement categories — MUST be identical on api + mobile.
const CLASS_LIQUID = '00000000-0000-4000-8000-000000000c01';
const CLASS_PIECE = '00000000-0000-4000-8000-000000000c02';
const CLASS_LENGTH = '00000000-0000-4000-8000-000000000c03';
const CLASS_WEIGHT = '00000000-0000-4000-8000-000000000c04';

// meta JSON carries curated units + allowDecimals copied from src/constants/units.ts
// (UNIT_OPTIONS / ALLOWS_DECIMALS).
const META_LIQUID = '{"units":["gallon","quart","pint","cup","fl oz","liter","ml"],"allowDecimals":true}';
const META_PIECE = '{"units":["each","pair","box","case","pack","set","roll"],"allowDecimals":false}';
const META_LENGTH = '{"units":["ft","in","yd","m","cm"],"allowDecimals":true}';
const META_WEIGHT = '{"units":["lb","oz","kg","g"],"allowDecimals":true}';

export const migration = {
  version: 12,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE taxonomy_types ADD COLUMN meta TEXT`);
    db.executeSync(`ALTER TABLE locations ADD COLUMN subareas_require_owner INTEGER NOT NULL DEFAULT 0`);

    // Seed 4 product_class rows by fixed UUID (idempotent via INSERT OR IGNORE on PK).
    db.executeSync(
      `INSERT OR IGNORE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta)
       VALUES (?, 'product_class', 'Liquid', NULL, 0, 1, datetime('now'), ?)`,
      [CLASS_LIQUID, META_LIQUID]
    );
    db.executeSync(
      `INSERT OR IGNORE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta)
       VALUES (?, 'product_class', 'Pieces', NULL, 1, 1, datetime('now'), ?)`,
      [CLASS_PIECE, META_PIECE]
    );
    db.executeSync(
      `INSERT OR IGNORE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta)
       VALUES (?, 'product_class', 'Length', NULL, 2, 1, datetime('now'), ?)`,
      [CLASS_LENGTH, META_LENGTH]
    );
    db.executeSync(
      `INSERT OR IGNORE INTO taxonomy_types (id, category, label, icon, sort_order, active, updated_at, meta)
       VALUES (?, 'product_class', 'Weight', NULL, 3, 1, datetime('now'), ?)`,
      [CLASS_WEIGHT, META_WEIGHT]
    );

    // Remap items from the 4 legacy enum keys to the fixed class UUIDs (idempotent).
    db.executeSync(`UPDATE inventory_items SET unit_category = ? WHERE unit_category = 'liquid'`, [CLASS_LIQUID]);
    db.executeSync(`UPDATE inventory_items SET unit_category = ? WHERE unit_category = 'piece'`, [CLASS_PIECE]);
    db.executeSync(`UPDATE inventory_items SET unit_category = ? WHERE unit_category = 'length'`, [CLASS_LENGTH]);
    db.executeSync(`UPDATE inventory_items SET unit_category = ? WHERE unit_category = 'weight'`, [CLASS_WEIGHT]);
  },
};
