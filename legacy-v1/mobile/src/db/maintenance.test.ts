import { createRequire } from 'node:module';
import { test, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// maintenance.ts pulls in db/schema (via appConfig) + sync/outbox, both of
// which need a DB under test. Reuse the Module._load redirect already
// established by tx.test.ts / locationsShelf.test.ts: db/schema becomes the
// sql.js test double (locationsShelf.testdb.ts) so appendOutbox hits real
// SQLite instead of the native op-sqlite binding. That test double doesn't
// carry an app_config table, so these tests exercise the #199 preview-block
// flag (pure in-module state) rather than toggling real maintenance mode —
// isMaintenanceActive() safely reads as "off" (getAppConfig swallows the
// missing-table error), which is exactly the default-behavior baseline these
// tests need.
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Module = requireCjs('node:module') as any;
const testDb = requireCjs('./queries/locationsShelf.testdb') as typeof import('./queries/locationsShelf.testdb');

const origLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'react-native-get-random-values') return {};
  let resolved = '';
  try { resolved = Module._resolveFilename(request, parent); } catch { /* not ours — fall through */ }
  if (resolved.endsWith('/src/db/schema.ts')) return testDb;
  return origLoad.call(this, request, parent, isMain);
};

let maintenance: typeof import('./maintenance');
let outbox: typeof import('../sync/outbox');

before(async () => {
  await testDb.initTestDb();
  maintenance = requireCjs('./maintenance') as typeof import('./maintenance');
  outbox = requireCjs('../sync/outbox') as typeof import('../sync/outbox');
});

beforeEach(() => {
  maintenance.setMaintenanceRole(null);
  maintenance.setPreviewWriteBlock(false);
});

afterEach(() => {
  maintenance.setMaintenanceRole(null);
  maintenance.setPreviewWriteBlock(false);
});

test('default: no preview active, writes are not blocked (behavior unchanged from pre-#199)', () => {
  assert.equal(maintenance.isPreviewWriteBlocked(), false);
  assert.equal(maintenance.isWriteBlocked(), false);
  assert.doesNotThrow(() => maintenance.assertWritable());
  assert.doesNotThrow(() =>
    outbox.appendOutbox('INSERT', 'vehicles', { location_id: 'veh-1', truck_mount: 1 }),
  );
});

test('#199: setPreviewWriteBlock(true) blocks writes centrally, with a message distinct from maintenance mode', () => {
  maintenance.setPreviewWriteBlock(true);
  assert.equal(maintenance.isPreviewWriteBlocked(), true);
  assert.equal(maintenance.isWriteBlocked(), true);
  assert.throws(
    () => maintenance.assertWritable(),
    (err: unknown) => err instanceof maintenance.MaintenanceLockedError
      && err.message === 'Preview mode is read-only.'
      && err.message !== 'System is under maintenance (read-only).',
  );
});

test('#199: preview write block also blocks appendOutbox — same failure path as maintenance mode, not a crash', () => {
  maintenance.setPreviewWriteBlock(true);
  assert.throws(
    () => outbox.appendOutbox('INSERT', 'vehicles', { location_id: 'veh-2', truck_mount: 1 }),
    (err: unknown) => err instanceof maintenance.MaintenanceLockedError
      && err.message === 'Preview mode is read-only.',
  );
});

test('#199: preview write block is unconditional — a tier-4 (maintenance-exempt) role is still blocked', () => {
  maintenance.setMaintenanceRole('full_admin'); // normally exempt from maintenance lockout
  maintenance.setPreviewWriteBlock(true);
  assert.equal(maintenance.isWriteBlocked(), true);
  assert.throws(() => maintenance.assertWritable(), maintenance.MaintenanceLockedError);
});

test('#199: setPreviewWriteBlock(false) fully restores default (non-preview) behavior', () => {
  maintenance.setPreviewWriteBlock(true);
  assert.equal(maintenance.isWriteBlocked(), true);
  maintenance.setPreviewWriteBlock(false);
  assert.equal(maintenance.isPreviewWriteBlocked(), false);
  assert.equal(maintenance.isWriteBlocked(), false);
  assert.doesNotThrow(() => maintenance.assertWritable());
});
