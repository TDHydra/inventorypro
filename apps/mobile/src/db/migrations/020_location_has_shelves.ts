import type { SqlDb } from '../types';

// Migration 020: per-location "has shelves" flag (INTEGER 0/1 locally). When set,
// add-stock offers a Shelf field; shelves are child locations of type 'Shelf'.
export const migration = {
  version: 20,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE locations ADD COLUMN has_shelves INTEGER NOT NULL DEFAULT 0`);
  },
};
