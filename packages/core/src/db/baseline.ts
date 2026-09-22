// The fresh-install schema for mobile-v2: every on-device table's verbatim
// DDL (captured from the old app's real 001–067 migration chain) straight
// from the manifest. This replaces the planned generated-file + regeneration
// test — deriving at runtime from the checked-in manifest leaves nothing to
// drift. Migration 001 in the app executes exactly these statements;
// baseline.test.ts proves the result matches every spec's column truth.
import { BASELINE_TABLES, tableDdl } from '../manifest/derive';

export function baselineDdl(): string[] {
  return BASELINE_TABLES.flatMap(tableDdl);
}
