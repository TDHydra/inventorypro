-- Migration 001: Initial schema
-- Creates all core tables for InventoryPro

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Role enum
CREATE TYPE user_role AS ENUM (
  'full_admin',
  'franchise_manager',
  'hr_manager',
  'office_manager',
  'head_of_construction',
  'head_of_contents',
  'production_manager',
  'carpet_cleaning_manager',
  'construction_crew',
  'contents_crew',
  'mitigation_technician',
  'carpet_cleaning_crew',
  'temporary_employee'
);

-- Unit category enum
CREATE TYPE unit_category AS ENUM ('liquid', 'piece', 'length', 'weight');

-- Role settings (PIN length per role, configurable by admin)
CREATE TABLE role_settings (
  role              user_role PRIMARY KEY,
  min_pin_length    INT NOT NULL DEFAULT 4 CHECK (min_pin_length BETWEEN 4 AND 8),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed default PIN lengths
INSERT INTO role_settings (role, min_pin_length) VALUES
  ('full_admin', 8),
  ('franchise_manager', 8),
  ('hr_manager', 6),
  ('office_manager', 6),
  ('head_of_construction', 6),
  ('head_of_contents', 6),
  ('production_manager', 6),
  ('carpet_cleaning_manager', 6),
  ('construction_crew', 4),
  ('contents_crew', 4),
  ('mitigation_technician', 4),
  ('carpet_cleaning_crew', 4),
  ('temporary_employee', 4);

-- Users
CREATE TABLE users (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                    TEXT NOT NULL,
  role                    user_role NOT NULL,
  pin_hash                TEXT NOT NULL,
  pin_length_required     INT NOT NULL CHECK (pin_length_required BETWEEN 4 AND 8),
  permission_overrides    JSONB NOT NULL DEFAULT '{}',
  active                  BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at              TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX users_role_idx ON users(role);
CREATE INDEX users_active_idx ON users(active);
CREATE INDEX users_updated_at_idx ON users(updated_at);

-- Locations (self-referencing for sub-areas)
CREATE TABLE locations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  parent_id   UUID REFERENCES locations(id) ON DELETE RESTRICT,
  color       TEXT,
  icon        TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX locations_parent_idx ON locations(parent_id);
CREATE INDEX locations_updated_at_idx ON locations(updated_at);

-- Inventory item catalog
CREATE TABLE inventory_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,
  barcode         TEXT UNIQUE,
  description     TEXT,
  unit_category   unit_category NOT NULL,
  unit            TEXT NOT NULL,
  min_qty_alert   DECIMAL(10,3) NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX inventory_items_barcode_idx ON inventory_items(barcode);
CREATE INDEX inventory_items_updated_at_idx ON inventory_items(updated_at);
CREATE INDEX inventory_items_name_idx ON inventory_items USING gin(to_tsvector('english', name));

-- Stock per location
CREATE TABLE stock_by_location (
  item_id     UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quantity    DECIMAL(10,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (item_id, location_id)
);

CREATE INDEX stock_by_location_item_idx ON stock_by_location(item_id);
CREATE INDEX stock_by_location_location_idx ON stock_by_location(location_id);
CREATE INDEX stock_by_location_updated_at_idx ON stock_by_location(updated_at);

-- Teams (defined before activity_log for FK)
CREATE TABLE teams (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  manager_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX teams_manager_idx ON teams(manager_id);
CREATE INDEX teams_updated_at_idx ON teams(updated_at);

-- Team members
CREATE TABLE team_members (
  team_id                   UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id                   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_permission_overrides JSONB NOT NULL DEFAULT '{}',
  added_by                  UUID REFERENCES users(id) ON DELETE SET NULL,
  joined_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, user_id)
);

-- Jobs
CREATE TABLE jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'archived')),
  created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX jobs_status_idx ON jobs(status);
CREATE INDEX jobs_updated_at_idx ON jobs(updated_at);

-- Immutable activity log
CREATE TABLE activity_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  team_id           UUID REFERENCES teams(id) ON DELETE SET NULL,
  action            TEXT NOT NULL,
  entity_type       TEXT NOT NULL,
  entity_id         UUID,
  from_location_id  UUID REFERENCES locations(id) ON DELETE SET NULL,
  to_location_id    UUID REFERENCES locations(id) ON DELETE SET NULL,
  quantity          DECIMAL(10,3),
  unit              TEXT,
  job_id            UUID REFERENCES jobs(id) ON DELETE SET NULL,
  note              TEXT,
  metadata          JSONB,
  device_id         TEXT,
  created_at        TIMESTAMPTZ NOT NULL,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX activity_log_user_idx ON activity_log(user_id);
CREATE INDEX activity_log_job_idx ON activity_log(job_id);
CREATE INDEX activity_log_entity_idx ON activity_log(entity_type, entity_id);
CREATE INDEX activity_log_created_at_idx ON activity_log(created_at DESC);
CREATE INDEX activity_log_synced_at_idx ON activity_log(synced_at);

-- Prevent updates and deletes on activity_log (immutable audit trail)
CREATE RULE no_update_activity_log AS ON UPDATE TO activity_log DO INSTEAD NOTHING;
CREATE RULE no_delete_activity_log AS ON DELETE TO activity_log DO INSTEAD NOTHING;

-- Universal media attachments
CREATE TABLE media (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT NOT NULL,
  entity_id     UUID NOT NULL,
  media_type    TEXT NOT NULL CHECK (media_type IN ('image', 'video')),
  url           TEXT NOT NULL,
  thumbnail_url TEXT,
  caption       TEXT,
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
  uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX media_entity_idx ON media(entity_type, entity_id);
CREATE INDEX media_primary_idx ON media(entity_type, entity_id, is_primary);

-- App settings (key-value store for server-side config)
CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
