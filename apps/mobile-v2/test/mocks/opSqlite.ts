// @op-engineering/op-sqlite is a native binding with no JS fallback — importing
// it under jest throws. Nothing should reach these: db/schema is mapped to
// test/pageTestDb.ts, so this only exists for modules that import op-sqlite
// directly (a typed `DB` import, feature-detection). Throwing on open() makes
// an accidental real-DB path loud instead of silently returning empty rows.
export function open(): never {
  throw new Error(
    'opSqlite mock: a page test tried to open the native database. ' +
    'Route DB access through src/db/schema (mapped to test/pageTestDb.ts) instead.',
  );
}
export function openSync(): never { return open(); }
export const isSQLCipher = () => false;
export const moveAssetsDatabase = async () => false;
export type DB = never;
