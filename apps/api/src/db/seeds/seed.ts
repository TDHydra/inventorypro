/**
 * Development seed — populates all 13 roles, sample users, locations,
 * inventory items, teams, and one open job.
 *
 * Run: pnpm tsx src/db/seeds/seed.ts
 */

import { Client } from 'pg';
import bcrypt from 'bcrypt';

const DB = process.env.DATABASE_URL;
if (!DB) throw new Error('DATABASE_URL required');

async function hash(pin: string) {
  return bcrypt.hash(pin, 10);
}

async function seed() {
  const client = new Client({ connectionString: DB });
  await client.connect();

  try {
    // ── Role settings ────────────────────────────────────────────────────────
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

    // ── Users ────────────────────────────────────────────────────────────────
    const users = [
      { name: 'Alex Admin',        role: 'full_admin',             pin: '12345678' },
      { name: 'Frank Franchise',   role: 'franchise_manager',      pin: '87654321' },
      { name: 'Hannah HR',         role: 'hr_manager',             pin: '111111' },
      { name: 'Oscar Office',      role: 'office_manager',         pin: '222222' },
      { name: 'Carl Construction', role: 'head_of_construction',   pin: '333333' },
      { name: 'Cora Contents',     role: 'head_of_contents',       pin: '444444' },
      { name: 'Pete Production',   role: 'production_manager',     pin: '555555' },
      { name: 'Cathy Carpet Mgr',  role: 'carpet_cleaning_manager',pin: '666666' },
      { name: 'Bob Builder',       role: 'construction_crew',      pin: '1234' },
      { name: 'Wendy Worker',      role: 'contents_crew',          pin: '2345' },
      { name: 'Mike Mito',         role: 'mitigation_technician',  pin: '3456' },
      { name: 'Gary Carpet',       role: 'carpet_cleaning_crew',   pin: '4567' },
      { name: 'Temp Tim',          role: 'temporary_employee',     pin: '5678', expires_at: '2027-01-01' },
    ];

    for (const u of users) {
      const pin_hash = await hash(u.pin);
      const pinLen = u.pin.length;
      await client.query(
        `INSERT INTO users (name, role, pin_hash, pin_length_required, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING`,
        [u.name, u.role, pin_hash, pinLen, u.expires_at ?? null]
      );
    }
    console.log('✓ users (13)');

    // ── Locations ────────────────────────────────────────────────────────────
    const { rows: [warehouse] } = await client.query(`
      INSERT INTO locations (name, color, icon) VALUES ('Warehouse', '#1E3A5F', 'warehouse')
      ON CONFLICT DO NOTHING RETURNING id
    `);
    const { rows: [shop] } = await client.query(`
      INSERT INTO locations (name, color, icon) VALUES ('Shop', '#2E7D32', 'store')
      ON CONFLICT DO NOTHING RETURNING id
    `);
    const { rows: [van1] } = await client.query(`
      INSERT INTO locations (name, color, icon) VALUES ('Van 1', '#C62828', 'local_shipping')
      ON CONFLICT DO NOTHING RETURNING id
    `);

    if (warehouse) {
      await client.query(`
        INSERT INTO locations (name, parent_id, color, icon) VALUES
          ('Shelf A', $1, '#1565C0', 'shelves'),
          ('Shelf B', $1, '#1565C0', 'shelves'),
          ('Back Room', $1, '#6A1B9A', 'door_back')
        ON CONFLICT DO NOTHING`, [warehouse.id]);
    }
    if (shop) {
      await client.query(`
        INSERT INTO locations (name, parent_id, color, icon) VALUES
          ('Front Counter', $1, '#EF6C00', 'counter'),
          ('Storage Bay', $1, '#00695C', 'garage')
        ON CONFLICT DO NOTHING`, [shop.id]);
    }
    console.log('✓ locations (3 parent + 5 sub-areas)');

    // ── Inventory items ──────────────────────────────────────────────────────
    const items: [string, string | null, string, string, number][] = [
      ['Dehumidifier LGR',     '0012345678901', 'piece',  'each',   2],
      ['Air Mover',            '0023456789012', 'piece',  'each',   5],
      ['Air Scrubber',         '0034567890123', 'piece',  'each',   3],
      ['Moisture Meter',       '0045678901234', 'piece',  'each',   1],
      ['Carpet Wand',          '0056789012345', 'piece',  'each',   2],
      ['Van Mount Extractor',  null,            'piece',  'each',   1],
      ['Antimicrobial Spray',  '0067890123456', 'liquid', 'gallon', 5],
      ['Deodorizer Concentrate','0078901234567','liquid', 'gallon', 3],
      ['Plastic Sheeting',     '0089012345678', 'length', 'ft',    10],
      ['Zip-tie Pack 100ct',   '0090123456789', 'piece',  'each',   4],
      ['Box Fan 20in',         '0101234567890', 'piece',  'each',   6],
      ['Extension Cord 50ft',  '0112345678901', 'length', 'ft',    10],
      ['Disposable Gloves M',  '0123456789012', 'piece',  'each',  20],
      ['N95 Respirator',       '0134567890123', 'piece',  'each',  50],
      ['Carpet Cleaning Solution','0145678901234','liquid','gallon', 8],
    ];

    const itemIds: Record<string, string> = {};
    for (const [name, barcode, unit_category, unit, min_qty_alert] of items) {
      const { rows: [row] } = await client.query(
        `INSERT INTO inventory_items (name, barcode, unit_category, unit, min_qty_alert)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT DO NOTHING RETURNING id`,
        [name, barcode, unit_category, unit, min_qty_alert]
      );
      if (row) itemIds[name] = row.id;
    }
    console.log('✓ inventory_items (15)');

    // ── Stock by location ────────────────────────────────────────────────────
    if (warehouse) {
      const stockRows = Object.entries(itemIds).map(([, id]) => [id, warehouse.id, Math.floor(Math.random() * 8) + 2]);
      for (const [item_id, location_id, quantity] of stockRows) {
        await client.query(
          `INSERT INTO stock_by_location (item_id, location_id, quantity)
           VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [item_id, location_id, quantity]
        );
      }
    }
    if (van1 && itemIds['Air Mover'] && itemIds['Dehumidifier LGR']) {
      await client.query(
        `INSERT INTO stock_by_location (item_id, location_id, quantity) VALUES
           ($1, $2, 2), ($3, $2, 1) ON CONFLICT DO NOTHING`,
        [itemIds['Air Mover'], van1.id, itemIds['Dehumidifier LGR']]
      );
    }
    console.log('✓ stock_by_location');

    // ── Teams ────────────────────────────────────────────────────────────────
    await client.query(
      `INSERT INTO teams (name, type) VALUES
         ('Mito Team Alpha', 'mitigation'),
         ('Construction A',  'construction')
       ON CONFLICT DO NOTHING`
    );
    // Managers are team_members with is_manager=TRUE (manager_id dropped in 027).
    await client.query(
      `INSERT INTO team_members (team_id, user_id, is_manager)
         SELECT t.id, u.id, TRUE FROM teams t JOIN users u ON
           (t.name = 'Mito Team Alpha' AND u.name = 'Pete Production') OR
           (t.name = 'Construction A'  AND u.name = 'Carl Construction')
       ON CONFLICT DO NOTHING`
    );
    console.log('✓ teams (2)');

    // ── Jobs ─────────────────────────────────────────────────────────────────
    const { rows: [alexRow] } = await client.query(
      `SELECT id FROM users WHERE name = 'Alex Admin' LIMIT 1`
    );
    await client.query(
      `INSERT INTO jobs (name, status, created_by) VALUES
         ('123 Main St Water Loss', 'open',   $1),
         ('456 Oak Ave Fire Damage','open',   $1),
         ('789 Pine Rd Completed',  'closed', $1)
       ON CONFLICT DO NOTHING`,
      [alexRow?.id ?? null]
    );
    console.log('✓ jobs (3)');

    console.log('\n✅ Seed complete.');
  } finally {
    await client.end();
  }
}

seed().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
