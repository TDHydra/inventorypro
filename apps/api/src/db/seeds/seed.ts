/**
 * Development seed — populates all 13 roles, sample users, locations,
 * inventory items, teams, and jobs.
 *
 * By default it seeds the curated baseline (13 users, 3 locations, 15 items,
 * 3 jobs, 2 teams). It can also generate BULK sample data for load/UX testing
 * via env vars or CLI flags:
 *
 *   pnpm tsx src/db/seeds/seed.ts                       # baseline
 *   SEED_ITEMS=500 SEED_JOBS=200 pnpm tsx …/seed.ts     # via env
 *   pnpm tsx src/db/seeds/seed.ts --items=500 --jobs=200 --locations=50
 *
 * Configurable counts: users, locations, items, jobs, teams. Counts only
 * scale UP — the curated baseline is always preserved — and are clamped to a
 * safe maximum. Every INSERT is ON CONFLICT DO NOTHING, so re-running is
 * idempotent-ish (existing rows are left untouched).
 *
 * Dev-only: refuses to run when NODE_ENV=production unless SEED_ALLOW_PROD=1.
 */

import { Client } from 'pg';
import bcrypt from 'bcrypt';

// ── Config ──────────────────────────────────────────────────────────────────

export interface SeedConfig {
  users: number;
  locations: number;
  items: number;
  jobs: number;
  teams: number;
}

/** Curated baseline counts — counts never fall below these. */
export const SEED_BASE: SeedConfig = {
  users: 13,
  locations: 3,
  items: 15,
  jobs: 3,
  teams: 2,
};

/** Safety caps so a fat-fingered flag can't try to insert millions of rows. */
export const SEED_MAX: SeedConfig = {
  users: 500,
  locations: 2000,
  items: 5000,
  jobs: 5000,
  teams: 500,
};

type Env = Record<string, string | undefined>;

/** ENV var name for each configurable count. */
const ENV_KEY: Record<keyof SeedConfig, string> = {
  users: 'SEED_USERS',
  locations: 'SEED_LOCATIONS',
  items: 'SEED_ITEMS',
  jobs: 'SEED_JOBS',
  teams: 'SEED_TEAMS',
};

/** CLI flag name (`--items=N`) for each configurable count. */
const CLI_KEY: Record<keyof SeedConfig, string> = {
  users: 'users',
  locations: 'locations',
  items: 'items',
  jobs: 'jobs',
  teams: 'teams',
};

function parseCliFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of argv) {
    const m = /^--([a-zA-Z][\w-]*)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Resolve counts from CLI flags (highest priority), then env vars, then the
 * curated baseline. Non-numeric input falls back to the baseline; values are
 * clamped to [base, max] so we only ever scale up, never past the safety cap.
 */
export function parseSeedConfig(env: Env, argv: string[]): SeedConfig {
  const cli = parseCliFlags(argv);
  const cfg = {} as SeedConfig;

  for (const key of Object.keys(SEED_BASE) as (keyof SeedConfig)[]) {
    const raw = cli[CLI_KEY[key]] ?? env[ENV_KEY[key]];
    const base = SEED_BASE[key];
    let n = base;
    if (raw !== undefined && raw !== '') {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) n = Math.floor(parsed);
    }
    cfg[key] = Math.min(SEED_MAX[key], Math.max(base, n));
  }

  return cfg;
}

/** Refuse to run against a production database unless explicitly overridden. */
export function assertDevOnly(env: Env): void {
  if (env.NODE_ENV === 'production' && env.SEED_ALLOW_PROD !== '1') {
    throw new Error(
      'Refusing to seed: NODE_ENV=production. Set SEED_ALLOW_PROD=1 to override.',
    );
  }
}

// ── Data generators (pure) ──────────────────────────────────────────────────

type ItemTuple = [
  name: string,
  barcode: string | null,
  unit_category: string,
  unit: string,
  min_qty_alert: number,
];

const BASE_ITEMS: ItemTuple[] = [
  ['Dehumidifier LGR', '0012345678901', 'piece', 'each', 2],
  ['Air Mover', '0023456789012', 'piece', 'each', 5],
  ['Air Scrubber', '0034567890123', 'piece', 'each', 3],
  ['Moisture Meter', '0045678901234', 'piece', 'each', 1],
  ['Carpet Wand', '0056789012345', 'piece', 'each', 2],
  ['Van Mount Extractor', null, 'piece', 'each', 1],
  ['Antimicrobial Spray', '0067890123456', 'liquid', 'gallon', 5],
  ['Deodorizer Concentrate', '0078901234567', 'liquid', 'gallon', 3],
  ['Plastic Sheeting', '0089012345678', 'length', 'ft', 10],
  ['Zip-tie Pack 100ct', '0090123456789', 'piece', 'each', 4],
  ['Box Fan 20in', '0101234567890', 'piece', 'each', 6],
  ['Extension Cord 50ft', '0112345678901', 'length', 'ft', 10],
  ['Disposable Gloves M', '0123456789012', 'piece', 'each', 20],
  ['N95 Respirator', '0134567890123', 'piece', 'each', 50],
  ['Carpet Cleaning Solution', '0145678901234', 'liquid', 'gallon', 8],
];

const SYNTH_UNITS: [string, string][] = [
  ['piece', 'each'],
  ['liquid', 'gallon'],
  ['length', 'ft'],
];

/** Synthetic 13-digit barcode that won't collide with the base 00xx/01xx set. */
function synthBarcode(n: number): string {
  return ('9' + String(n).padStart(12, '0')).slice(0, 13);
}

/** Curated base items first, then deterministic synthetic ones, exactly `count`. */
export function genItems(count: number): ItemTuple[] {
  const out = BASE_ITEMS.slice(0, Math.min(count, BASE_ITEMS.length));
  for (let i = BASE_ITEMS.length; i < count; i++) {
    const n = i + 1;
    const [category, unit] = SYNTH_UNITS[i % SYNTH_UNITS.length];
    out.push([`Sample Item ${n}`, synthBarcode(n), category, unit, (n % 10) + 1]);
  }
  return out;
}

interface JobSpec {
  name: string;
  status: 'open' | 'closed';
}

const BASE_JOBS: JobSpec[] = [
  { name: '123 Main St Water Loss', status: 'open' },
  { name: '456 Oak Ave Fire Damage', status: 'open' },
  { name: '789 Pine Rd Completed', status: 'closed' },
];

export function genJobs(count: number): JobSpec[] {
  const out = BASE_JOBS.slice(0, Math.min(count, BASE_JOBS.length));
  for (let i = BASE_JOBS.length; i < count; i++) {
    const n = i + 1;
    out.push({ name: `Sample Job ${n}`, status: n % 4 === 0 ? 'closed' : 'open' });
  }
  return out;
}

interface LocationSpec {
  name: string;
  color: string;
  icon: string;
}

const BASE_LOCATIONS: LocationSpec[] = [
  { name: 'Warehouse', color: '#1E3A5F', icon: 'warehouse' },
  { name: 'Shop', color: '#2E7D32', icon: 'store' },
  { name: 'Van 1', color: '#C62828', icon: 'local_shipping' },
];

export function genLocations(count: number): LocationSpec[] {
  const out = BASE_LOCATIONS.slice(0, Math.min(count, BASE_LOCATIONS.length));
  for (let i = BASE_LOCATIONS.length; i < count; i++) {
    const n = i + 1;
    out.push({ name: `Location ${n}`, color: '#455A64', icon: 'place' });
  }
  return out;
}

interface UserSpec {
  name: string;
  role: string;
  pin: string;
  expires_at?: string;
}

const BASE_USERS: UserSpec[] = [
  { name: 'Alex Admin', role: 'full_admin', pin: '12345678' },
  { name: 'Frank Franchise', role: 'franchise_manager', pin: '87654321' },
  { name: 'Hannah HR', role: 'hr_manager', pin: '111111' },
  { name: 'Oscar Office', role: 'office_manager', pin: '222222' },
  { name: 'Carl Construction', role: 'head_of_construction', pin: '333333' },
  { name: 'Cora Contents', role: 'head_of_contents', pin: '444444' },
  { name: 'Pete Production', role: 'production_manager', pin: '555555' },
  { name: 'Cathy Carpet Mgr', role: 'carpet_cleaning_manager', pin: '666666' },
  { name: 'Bob Builder', role: 'construction_crew', pin: '1234' },
  { name: 'Wendy Worker', role: 'contents_crew', pin: '2345' },
  { name: 'Mike Mito', role: 'mitigation_technician', pin: '3456' },
  { name: 'Gary Carpet', role: 'carpet_cleaning_crew', pin: '4567' },
  { name: 'Temp Tim', role: 'temporary_employee', pin: '5678', expires_at: '2027-01-01' },
];

/**
 * Synthetic users BEYOND the curated 13 — all temporary_employee (PIN min 4),
 * so no privileged synthetic accounts are ever created.
 */
export function genExtraUsers(totalUsers: number): UserSpec[] {
  const out: UserSpec[] = [];
  for (let i = BASE_USERS.length; i < totalUsers; i++) {
    const n = i + 1;
    out.push({
      name: `Temp User ${n}`,
      role: 'temporary_employee',
      pin: String(n).padStart(4, '0').slice(-6),
      expires_at: '2027-01-01',
    });
  }
  return out;
}

interface TeamSpec {
  name: string;
  type: string;
}

const BASE_TEAMS: TeamSpec[] = [
  { name: 'Mito Team Alpha', type: 'mitigation' },
  { name: 'Construction A', type: 'construction' },
];

export function genExtraTeams(totalTeams: number): TeamSpec[] {
  const out: TeamSpec[] = [];
  for (let i = BASE_TEAMS.length; i < totalTeams; i++) {
    const n = i + 1;
    out.push({ name: `Team ${n}`, type: n % 2 === 0 ? 'mitigation' : 'construction' });
  }
  return out;
}

// ── Seed runner ─────────────────────────────────────────────────────────────

async function hash(pin: string) {
  return bcrypt.hash(pin, 10);
}

export async function seed(client: Client, cfg: SeedConfig): Promise<void> {
  // ── Role settings ──────────────────────────────────────────────────────────
  await client.query(`
    INSERT INTO role_settings (role, min_pin_length) VALUES
      ('full_admin',             8),
      ('franchise_manager',      8),
      ('hr_manager',             6),
      ('office_manager',         6),
      ('head_of_construction',   6),
      ('head_of_contents',       6),
      ('production_manager',     6),
      ('carpet_cleaning_manager',6),
      ('construction_crew',      4),
      ('contents_crew',          4),
      ('mitigation_technician',  4),
      ('carpet_cleaning_crew',   4),
      ('temporary_employee',     4)
    ON CONFLICT DO NOTHING
  `);
  console.log('✓ role_settings');

  // ── Users ──────────────────────────────────────────────────────────────────
  const users: UserSpec[] = [...BASE_USERS, ...genExtraUsers(cfg.users)];
  for (const u of users) {
    const pin_hash = await hash(u.pin);
    await client.query(
      `INSERT INTO users (name, role, pin_hash, pin_length_required, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [u.name, u.role, pin_hash, u.pin.length, u.expires_at ?? null],
    );
  }
  console.log(`✓ users (${users.length})`);

  // ── Locations ──────────────────────────────────────────────────────────────
  const locationSpecs = genLocations(cfg.locations);
  const locationIds: Record<string, string> = {};
  for (const loc of locationSpecs) {
    const { rows: [row] } = await client.query(
      `INSERT INTO locations (name, color, icon) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING id`,
      [loc.name, loc.color, loc.icon],
    );
    if (row) locationIds[loc.name] = row.id;
  }

  // Curated sub-areas under the two named parents (unchanged baseline structure).
  if (locationIds['Warehouse']) {
    await client.query(
      `INSERT INTO locations (name, parent_id, color, icon) VALUES
         ('Shelf A', $1, '#1565C0', 'shelves'),
         ('Shelf B', $1, '#1565C0', 'shelves'),
         ('Back Room', $1, '#6A1B9A', 'door_back')
       ON CONFLICT DO NOTHING`,
      [locationIds['Warehouse']],
    );
  }
  if (locationIds['Shop']) {
    await client.query(
      `INSERT INTO locations (name, parent_id, color, icon) VALUES
         ('Front Counter', $1, '#EF6C00', 'counter'),
         ('Storage Bay', $1, '#00695C', 'garage')
       ON CONFLICT DO NOTHING`,
      [locationIds['Shop']],
    );
  }
  console.log(`✓ locations (${locationSpecs.length} parent + curated sub-areas)`);

  // ── Inventory items ────────────────────────────────────────────────────────
  const itemSpecs = genItems(cfg.items);
  const itemIds: Record<string, string> = {};
  for (const [name, barcode, unit_category, unit, min_qty_alert] of itemSpecs) {
    const { rows: [row] } = await client.query(
      `INSERT INTO inventory_items (name, barcode, unit_category, unit, min_qty_alert)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING RETURNING id`,
      [name, barcode, unit_category, unit, min_qty_alert],
    );
    if (row) itemIds[name] = row.id;
  }
  console.log(`✓ inventory_items (${itemSpecs.length})`);

  // ── Stock by location ──────────────────────────────────────────────────────
  const warehouseId = locationIds['Warehouse'];
  if (warehouseId) {
    for (const id of Object.values(itemIds)) {
      await client.query(
        `INSERT INTO stock_by_location (item_id, location_id, quantity)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [id, warehouseId, Math.floor(Math.random() * 8) + 2],
      );
    }
  }
  const van1Id = locationIds['Van 1'];
  if (van1Id && itemIds['Air Mover'] && itemIds['Dehumidifier LGR']) {
    await client.query(
      `INSERT INTO stock_by_location (item_id, location_id, quantity) VALUES
         ($1, $2, 2), ($3, $2, 1) ON CONFLICT DO NOTHING`,
      [itemIds['Air Mover'], van1Id, itemIds['Dehumidifier LGR']],
    );
  }
  console.log('✓ stock_by_location');

  // ── Teams ──────────────────────────────────────────────────────────────────
  const teamSpecs = [...BASE_TEAMS, ...genExtraTeams(cfg.teams)];
  for (const t of teamSpecs) {
    await client.query(
      `INSERT INTO teams (name, type) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [t.name, t.type],
    );
  }
  // Managers are team_members with is_manager=TRUE (manager_id dropped in 027).
  await client.query(
    `INSERT INTO team_members (team_id, user_id, is_manager)
       SELECT t.id, u.id, TRUE FROM teams t JOIN users u ON
         (t.name = 'Mito Team Alpha' AND u.name = 'Pete Production') OR
         (t.name = 'Construction A'  AND u.name = 'Carl Construction')
     ON CONFLICT DO NOTHING`,
  );
  console.log(`✓ teams (${teamSpecs.length})`);

  // ── Jobs ───────────────────────────────────────────────────────────────────
  const { rows: [alexRow] } = await client.query(
    `SELECT id FROM users WHERE name = 'Alex Admin' LIMIT 1`,
  );
  const jobSpecs = genJobs(cfg.jobs);
  for (const j of jobSpecs) {
    await client.query(
      `INSERT INTO jobs (name, status, created_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [j.name, j.status, alexRow?.id ?? null],
    );
  }
  console.log(`✓ jobs (${jobSpecs.length})`);

  console.log('\n✅ Seed complete.');
}

// ── Standalone entrypoint ───────────────────────────────────────────────────

async function main() {
  assertDevOnly(process.env);

  const DB = process.env.DATABASE_URL;
  if (!DB) throw new Error('DATABASE_URL required');

  const cfg = parseSeedConfig(process.env, process.argv.slice(2));
  console.log(
    `Seeding: users=${cfg.users} locations=${cfg.locations} items=${cfg.items} ` +
      `jobs=${cfg.jobs} teams=${cfg.teams}`,
  );

  const client = new Client({ connectionString: DB });
  await client.connect();
  try {
    await seed(client, cfg);
  } finally {
    await client.end();
  }
}

// Only run when invoked directly (not when imported by the test file).
if (require.main === module) {
  main().catch((err) => {
    console.error('Seed failed:', err.message);
    process.exit(1);
  });
}
