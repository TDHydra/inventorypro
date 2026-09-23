CREATE TABLE IF NOT EXISTS taxonomy_types (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category    TEXT NOT NULL,
  label       TEXT NOT NULL,
  icon        TEXT,
  sort_order  INT NOT NULL DEFAULT 0,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS type TEXT;

-- Seed team types (idempotent by category+label)
INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'team', 'operations', NULL, 0
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'team' AND label = 'operations');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'team', 'management', NULL, 1
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'team' AND label = 'management');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'team', 'construction', NULL, 2
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'team' AND label = 'construction');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'team', 'contents', NULL, 3
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'team' AND label = 'contents');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'team', 'cleaning', NULL, 4
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'team' AND label = 'cleaning');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'team', 'admin', NULL, 5
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'team' AND label = 'admin');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'team', 'other', NULL, 6
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'team' AND label = 'other');

-- Seed job types (idempotent by category+label)
INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'job', 'Fire damage', '🔥', 0
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'job' AND label = 'Fire damage');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'job', 'Water damage', '💧', 1
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'job' AND label = 'Water damage');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'job', 'Mold', '🦠', 2
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'job' AND label = 'Mold');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'job', 'Cleaning', '🧽', 3
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'job' AND label = 'Cleaning');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'job', 'Construction', '🛠️', 4
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'job' AND label = 'Construction');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'job', 'Carpet', '🧶', 5
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'job' AND label = 'Carpet');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'job', 'Moving', '📦', 6
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'job' AND label = 'Moving');

INSERT INTO taxonomy_types (category, label, icon, sort_order)
SELECT 'job', 'Other', '🗂️', 7
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'job' AND label = 'Other');
