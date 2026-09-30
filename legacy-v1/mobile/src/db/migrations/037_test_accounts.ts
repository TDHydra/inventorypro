import type { SqlDb } from '../types';

// Migration 037: public test/demo accounts. Mirrors API migration 045.
//
// is_test marks the seeded demo users (synced down from the server; the local
// column lets the login picker and session flag them). enrollment_code_public
// is the publicly displayed access code — plaintext by design, only ever
// non-null on is_test rows (the server projects it through CASE WHEN is_test).
export const migration = {
  version: 37,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE users ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0`);
    db.executeSync(`ALTER TABLE users ADD COLUMN enrollment_code_public TEXT`);
  },
};
