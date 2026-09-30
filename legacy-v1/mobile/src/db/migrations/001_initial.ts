import type { SqlDb } from '../types';

export const migration = {
  version: 1,
  up: (db: SqlDb): void => {
    // Role settings
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS role_settings (
        role              TEXT PRIMARY KEY,
        min_pin_length    INTEGER NOT NULL DEFAULT 4,
        updated_at        TEXT NOT NULL
      )
    `);

    // Users
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS users (
        id                    TEXT PRIMARY KEY,
        name                  TEXT NOT NULL,
        role                  TEXT NOT NULL,
        pin_length_required   INTEGER NOT NULL,
        permission_overrides  TEXT NOT NULL DEFAULT '{}',
        active                INTEGER NOT NULL DEFAULT 1,
        expires_at            TEXT,
        created_at            TEXT NOT NULL,
        updated_at            TEXT NOT NULL,
        synced_at             TEXT
      )
    `);
    db.executeSync(`CREATE INDEX IF NOT EXISTS users_role_idx ON users(role)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS users_updated_at_idx ON users(updated_at)`);

    // Locations
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS locations (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        parent_id   TEXT REFERENCES locations(id),
        color       TEXT,
        icon        TEXT,
        updated_at  TEXT NOT NULL,
        synced_at   TEXT
      )
    `);
    db.executeSync(`CREATE INDEX IF NOT EXISTS locations_parent_idx ON locations(parent_id)`);

    // Inventory items
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS inventory_items (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        barcode         TEXT UNIQUE,
        description     TEXT,
        unit_category   TEXT NOT NULL,
        unit            TEXT NOT NULL,
        min_qty_alert   REAL NOT NULL DEFAULT 0,
        active          INTEGER NOT NULL DEFAULT 1,
        updated_at      TEXT NOT NULL,
        synced_at       TEXT
      )
    `);
    db.executeSync(`CREATE INDEX IF NOT EXISTS items_barcode_idx ON inventory_items(barcode)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS items_name_idx ON inventory_items(name)`);

    // Stock by location
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS stock_by_location (
        item_id     TEXT NOT NULL REFERENCES inventory_items(id),
        location_id TEXT NOT NULL REFERENCES locations(id),
        quantity    REAL NOT NULL DEFAULT 0,
        updated_at  TEXT NOT NULL,
        synced_at   TEXT,
        PRIMARY KEY (item_id, location_id)
      )
    `);
    db.executeSync(`CREATE INDEX IF NOT EXISTS stock_item_idx ON stock_by_location(item_id)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS stock_location_idx ON stock_by_location(location_id)`);

    // Teams
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS teams (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        type        TEXT NOT NULL,
        manager_id  TEXT REFERENCES users(id),
        updated_at  TEXT NOT NULL,
        synced_at   TEXT
      )
    `);

    // Team members
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS team_members (
        team_id                   TEXT NOT NULL REFERENCES teams(id),
        user_id                   TEXT NOT NULL REFERENCES users(id),
        team_permission_overrides TEXT NOT NULL DEFAULT '{}',
        added_by                  TEXT REFERENCES users(id),
        joined_at                 TEXT NOT NULL,
        PRIMARY KEY (team_id, user_id)
      )
    `);

    // Jobs
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS jobs (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        created_by  TEXT REFERENCES users(id),
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        synced_at   TEXT
      )
    `);
    db.executeSync(`CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(status)`);

    // Activity log (local — append only, syncs to server)
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS activity_log (
        id                TEXT PRIMARY KEY,
        user_id           TEXT REFERENCES users(id),
        team_id           TEXT REFERENCES teams(id),
        action            TEXT NOT NULL,
        entity_type       TEXT NOT NULL,
        entity_id         TEXT,
        from_location_id  TEXT REFERENCES locations(id),
        to_location_id    TEXT REFERENCES locations(id),
        quantity          REAL,
        unit              TEXT,
        job_id            TEXT REFERENCES jobs(id),
        note              TEXT,
        metadata          TEXT,
        device_id         TEXT,
        created_at        TEXT NOT NULL,
        synced_at         TEXT
      )
    `);
    db.executeSync(`CREATE INDEX IF NOT EXISTS log_user_idx ON activity_log(user_id)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS log_created_idx ON activity_log(created_at DESC)`);
    db.executeSync(`CREATE INDEX IF NOT EXISTS log_entity_idx ON activity_log(entity_type, entity_id)`);

    // Media metadata (URLs stored, actual files on MinIO)
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS media (
        id            TEXT PRIMARY KEY,
        entity_type   TEXT NOT NULL,
        entity_id     TEXT NOT NULL,
        media_type    TEXT NOT NULL,
        url           TEXT NOT NULL,
        thumbnail_url TEXT,
        caption       TEXT,
        is_primary    INTEGER NOT NULL DEFAULT 0,
        uploaded_by   TEXT REFERENCES users(id),
        created_at    TEXT NOT NULL,
        synced_at     TEXT
      )
    `);
    db.executeSync(`CREATE INDEX IF NOT EXISTS media_entity_idx ON media(entity_type, entity_id)`);

    // Sync outbox (device-local only — never synced down from server)
    db.executeSync(`
      CREATE TABLE IF NOT EXISTS outbox (
        id          TEXT PRIMARY KEY,
        operation   TEXT NOT NULL,
        table_name  TEXT NOT NULL,
        payload     TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        attempts    INTEGER NOT NULL DEFAULT 0,
        last_error  TEXT,
        synced_at   TEXT
      )
    `);
    db.executeSync(`CREATE INDEX IF NOT EXISTS outbox_unsynced_idx ON outbox(synced_at, created_at)`);
  },
};
