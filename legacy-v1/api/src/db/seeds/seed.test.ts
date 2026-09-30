import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSeedConfig,
  assertDevOnly,
  genItems,
  genJobs,
  genLocations,
  genExtraUsers,
  genExtraTeams,
  SEED_BASE,
  SEED_MAX,
} from './seed';

// ── parseSeedConfig ─────────────────────────────────────────────────────────

test('parseSeedConfig defaults to the curated base counts', () => {
  const c = parseSeedConfig({}, []);
  assert.deepEqual(c, {
    users: SEED_BASE.users,
    locations: SEED_BASE.locations,
    items: SEED_BASE.items,
    jobs: SEED_BASE.jobs,
    teams: SEED_BASE.teams,
  });
});

test('env vars scale counts up', () => {
  const c = parseSeedConfig({ SEED_ITEMS: '100', SEED_JOBS: '50' }, []);
  assert.equal(c.items, 100);
  assert.equal(c.jobs, 50);
});

test('CLI --flag=value overrides env', () => {
  const c = parseSeedConfig({ SEED_ITEMS: '100' }, ['--items=250', '--locations=20']);
  assert.equal(c.items, 250);
  assert.equal(c.locations, 20);
});

test('counts never drop below the curated base (scale-up only)', () => {
  const c = parseSeedConfig({ SEED_ITEMS: '1' }, ['--jobs=0']);
  assert.equal(c.items, SEED_BASE.items);
  assert.equal(c.jobs, SEED_BASE.jobs);
});

test('counts are clamped to a safe maximum', () => {
  const c = parseSeedConfig({}, ['--items=999999999']);
  assert.equal(c.items, SEED_MAX.items);
});

test('non-numeric / garbage values fall back to the default', () => {
  assert.equal(parseSeedConfig({ SEED_ITEMS: 'abc' }, []).items, SEED_BASE.items);
  assert.equal(parseSeedConfig({}, ['--items=notanumber']).items, SEED_BASE.items);
});

// ── assertDevOnly ───────────────────────────────────────────────────────────

test('assertDevOnly throws in production without override', () => {
  assert.throws(() => assertDevOnly({ NODE_ENV: 'production' }), /production/i);
});

test('assertDevOnly allows production with SEED_ALLOW_PROD=1', () => {
  assert.doesNotThrow(() => assertDevOnly({ NODE_ENV: 'production', SEED_ALLOW_PROD: '1' }));
});

test('assertDevOnly allows non-production environments', () => {
  assert.doesNotThrow(() => assertDevOnly({ NODE_ENV: 'development' }));
  assert.doesNotThrow(() => assertDevOnly({}));
});

// ── generators ──────────────────────────────────────────────────────────────

test('genItems returns exactly count, curated base first then synthetic', () => {
  const items = genItems(20);
  assert.equal(items.length, 20);
  assert.equal(items[0][0], 'Dehumidifier LGR'); // curated base preserved
  assert.equal(items[15][0], 'Sample Item 16'); // synthetic beyond base
});

test('genItems produces unique names and unique (non-null) barcodes at scale', () => {
  const items = genItems(200);
  const names = new Set(items.map((i) => i[0]));
  const barcodes = items.map((i) => i[1]).filter((b): b is string => b !== null);
  assert.equal(names.size, 200);
  assert.equal(new Set(barcodes).size, barcodes.length);
});

test('genItems can slice below the base size', () => {
  assert.equal(genItems(5).length, 5);
  assert.equal(genItems(0).length, 0);
});

test('genJobs returns exactly count with base preserved', () => {
  const jobs = genJobs(10);
  assert.equal(jobs.length, 10);
  assert.equal(jobs[0].name, '123 Main St Water Loss');
  assert.ok(jobs.every((j) => j.status === 'open' || j.status === 'closed'));
});

test('genLocations returns exactly count with base preserved', () => {
  const locs = genLocations(8);
  assert.equal(locs.length, 8);
  assert.equal(locs[0].name, 'Warehouse');
  assert.equal(new Set(locs.map((l) => l.name)).size, 8);
});

test('genExtraUsers only generates users beyond the base 14, all valid PIN length', () => {
  assert.equal(genExtraUsers(14).length, 0);
  const extra = genExtraUsers(21);
  assert.equal(extra.length, 7);
  assert.ok(extra.every((u) => u.pin.length >= 4));
  assert.equal(new Set(extra.map((u) => u.name)).size, extra.length);
});

test('genExtraTeams only generates teams beyond the base 2', () => {
  assert.equal(genExtraTeams(2).length, 0);
  assert.equal(genExtraTeams(5).length, 3);
});
