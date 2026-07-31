-- Dev seed for InventoryPro
-- PINs: tier-4(admin/franchise)=12345678/87654321, tier-3=111111-666666, tier-1/2=1234-5678

-- Role settings
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
  ('duct_cleaning_technician',4),
  ('temporary_employee',     4)
ON CONFLICT DO NOTHING;

-- Users (14 roles)
INSERT INTO users (name, role, pin_hash, pin_length_required, expires_at) VALUES
  ('Alex Admin',       'full_admin',             '$2b$10$eSg8ddXzSNdZ4tonPKqdMuRA6O9Pv9mgLszwt2rDnsG7yZQiuBkJq', 8, NULL),
  ('Frank Franchise',  'franchise_manager',      '$2b$10$OG8y.kqXIv4kf7sW02.6RuNWs4sKDydk36p20qjNJLoW3xx/KVlMq', 8, NULL),
  ('Hannah HR',        'hr_manager',             '$2b$10$axYxq.ybAtzoLb2qIqMdduCw/cLGQNIioHxudoVP/Ew31mi0Sn156', 6, NULL),
  ('Oscar Office',     'office_manager',         '$2b$10$fYGEOEE8/nTav5lTFnWcteiKyAm3Wfk1COFMYm6ud3AM7JTEUgV5S', 6, NULL),
  ('Carl Construction','head_of_construction',   '$2b$10$u5LXJCO8iHit.0cYi.xWXexY1Q2OY3xhhvG0h2EIf4mk2cW4qvToi', 6, NULL),
  ('Cora Contents',    'head_of_contents',       '$2b$10$sMTeAPXziBsxkZzK14EBK.36yF7qVtbaaT42ElfEQxnMhd/.GX3zm', 6, NULL),
  ('Pete Production',  'production_manager',     '$2b$10$sH0ZwZFwn7QggUpSXAqOj.uGAwM/7aEFa2pE4dSZ0LoVaPdcQ9bnm', 6, NULL),
  ('Cathy Carpet Mgr', 'carpet_cleaning_manager','$2b$10$igjnwuyDyZSnW.LPlEDxY.78uMbqrjT3yisPLhFD0Yq15cQLWJnR.', 6, NULL),
  ('Bob Builder',      'construction_crew',      '$2b$10$f3DxyVOGbFeK4c/WwJoWPuVlK99V9HwICcZfbU7g33ssyIXFKsb6S', 4, NULL),
  ('Wendy Worker',     'contents_crew',          '$2b$10$EoWOo3nsofk66AtZ6DE2ZOayQp1v9oA/oBm8.yAFsdwqcbQVXp6cK', 4, NULL),
  ('Mike Mito',        'mitigation_technician',  '$2b$10$wmAhJ1YA/hBzbOV/1BakbuYfbRsEJqo8eCYE0tWDZ4eN4DnHtLhtu', 4, NULL),
  ('Gary Carpet',      'carpet_cleaning_crew',   '$2b$10$BU1wMDsCP6A9jkUHmoxkuOiD68nK7e.4tIEIf2oQ9oWJKrpmm2rtG', 4, NULL),
  ('Eddie Ducts',      'duct_cleaning_technician','$2b$10$Mg6myFJHOvt3VsW3HRPkkOou/eopZDecks/6G2GyxKqzUnje2Ut2K', 4, NULL),
  ('Temp Tim',         'temporary_employee',     '$2b$10$MA1QiPI.UucklwV/w9lTBOZUDhn3PgnhDY1WacLJigdFanUxaSQze', 4, '2027-01-01')
ON CONFLICT DO NOTHING;

-- Seeded users already have PINs, so mark them set (skip first-login setup).
UPDATE users SET pin_set = TRUE WHERE pin_hash IS NOT NULL AND pin_hash <> '';

-- Locations
INSERT INTO locations (id, name, color, icon) VALUES
  ('aaaaaaaa-0001-0001-0001-000000000001', 'Warehouse', '#1E3A5F', 'warehouse'),
  ('aaaaaaaa-0002-0002-0002-000000000002', 'Shop',      '#2E7D32', 'store'),
  ('aaaaaaaa-0003-0003-0003-000000000003', 'Van 1',     '#C62828', 'local_shipping')
ON CONFLICT DO NOTHING;

INSERT INTO locations (name, parent_id, color, icon) VALUES
  ('Shelf A',      'aaaaaaaa-0001-0001-0001-000000000001', '#1565C0', 'shelves'),
  ('Shelf B',      'aaaaaaaa-0001-0001-0001-000000000001', '#1565C0', 'shelves'),
  ('Back Room',    'aaaaaaaa-0001-0001-0001-000000000001', '#6A1B9A', 'door_back'),
  ('Front Counter','aaaaaaaa-0002-0002-0002-000000000002', '#EF6C00', 'counter'),
  ('Storage Bay',  'aaaaaaaa-0002-0002-0002-000000000002', '#00695C', 'inventory_2')
ON CONFLICT DO NOTHING;

-- Inventory items
INSERT INTO inventory_items (id, name, barcode, unit_category, unit, min_qty_alert) VALUES
  ('bbbbbbbb-0001-0001-0001-000000000001','Dehumidifier LGR',          '0012345678901','piece', 'each',   2),
  ('bbbbbbbb-0002-0002-0002-000000000002','Air Mover',                  '0023456789012','piece', 'each',   5),
  ('bbbbbbbb-0003-0003-0003-000000000003','Air Scrubber',               '0034567890123','piece', 'each',   3),
  ('bbbbbbbb-0004-0004-0004-000000000004','Moisture Meter',             '0045678901234','piece', 'each',   1),
  ('bbbbbbbb-0005-0005-0005-000000000005','Carpet Wand',                '0056789012345','piece', 'each',   2),
  ('bbbbbbbb-0006-0006-0006-000000000006','Van Mount Extractor',        NULL,           'piece', 'each',   1),
  ('bbbbbbbb-0007-0007-0007-000000000007','Antimicrobial Spray',        '0067890123456','liquid','gallon', 5),
  ('bbbbbbbb-0008-0008-0008-000000000008','Deodorizer Concentrate',     '0078901234567','liquid','gallon', 3),
  ('bbbbbbbb-0009-0009-0009-000000000009','Plastic Sheeting',           '0089012345678','length','ft',    10),
  ('bbbbbbbb-0010-0010-0010-000000000010','Zip-tie Pack 100ct',         '0090123456789','piece', 'each',   4),
  ('bbbbbbbb-0011-0011-0011-000000000011','Box Fan 20in',               '0101234567890','piece', 'each',   6),
  ('bbbbbbbb-0012-0012-0012-000000000012','Extension Cord 50ft',        '0112345678901','length','ft',    10),
  ('bbbbbbbb-0013-0013-0013-000000000013','Disposable Gloves M',        '0123456789012','piece', 'each',  20),
  ('bbbbbbbb-0014-0014-0014-000000000014','N95 Respirator',             '0134567890123','piece', 'each',  50),
  ('bbbbbbbb-0015-0015-0015-000000000015','Carpet Cleaning Solution',   '0145678901234','liquid','gallon', 8)
ON CONFLICT DO NOTHING;

-- Stock at Warehouse
INSERT INTO stock_by_location (item_id, location_id, quantity) VALUES
  ('bbbbbbbb-0001-0001-0001-000000000001','aaaaaaaa-0001-0001-0001-000000000001', 4),
  ('bbbbbbbb-0002-0002-0002-000000000002','aaaaaaaa-0001-0001-0001-000000000001', 8),
  ('bbbbbbbb-0003-0003-0003-000000000003','aaaaaaaa-0001-0001-0001-000000000001', 3),
  ('bbbbbbbb-0004-0004-0004-000000000004','aaaaaaaa-0001-0001-0001-000000000001', 5),
  ('bbbbbbbb-0005-0005-0005-000000000005','aaaaaaaa-0001-0001-0001-000000000001', 3),
  ('bbbbbbbb-0006-0006-0006-000000000006','aaaaaaaa-0001-0001-0001-000000000001', 2),
  ('bbbbbbbb-0007-0007-0007-000000000007','aaaaaaaa-0001-0001-0001-000000000001', 10),
  ('bbbbbbbb-0008-0008-0008-000000000008','aaaaaaaa-0001-0001-0001-000000000001', 6),
  ('bbbbbbbb-0009-0009-0009-000000000009','aaaaaaaa-0001-0001-0001-000000000001', 200),
  ('bbbbbbbb-0010-0010-0010-000000000010','aaaaaaaa-0001-0001-0001-000000000001', 12),
  ('bbbbbbbb-0011-0011-0011-000000000011','aaaaaaaa-0001-0001-0001-000000000001', 8),
  ('bbbbbbbb-0012-0012-0012-000000000012','aaaaaaaa-0001-0001-0001-000000000001', 150),
  ('bbbbbbbb-0013-0013-0013-000000000013','aaaaaaaa-0001-0001-0001-000000000001', 100),
  ('bbbbbbbb-0014-0014-0014-000000000014','aaaaaaaa-0001-0001-0001-000000000001', 200),
  ('bbbbbbbb-0015-0015-0015-000000000015','aaaaaaaa-0001-0001-0001-000000000001', 15)
ON CONFLICT DO NOTHING;

-- Stock on Van 1
INSERT INTO stock_by_location (item_id, location_id, quantity) VALUES
  ('bbbbbbbb-0001-0001-0001-000000000001','aaaaaaaa-0003-0003-0003-000000000003', 1),
  ('bbbbbbbb-0002-0002-0002-000000000002','aaaaaaaa-0003-0003-0003-000000000003', 2),
  ('bbbbbbbb-0007-0007-0007-000000000007','aaaaaaaa-0003-0003-0003-000000000003', 2)
ON CONFLICT DO NOTHING;

-- Teams (managers are team_members with is_manager=TRUE; manager_id dropped in 027)
INSERT INTO teams (name, type) VALUES
  ('Mito Team Alpha', 'mitigation'),
  ('Construction A',  'construction')
ON CONFLICT DO NOTHING;

INSERT INTO team_members (team_id, user_id, is_manager)
SELECT t.id, u.id, TRUE FROM teams t JOIN users u ON
  (t.name = 'Mito Team Alpha' AND u.name = 'Pete Production') OR
  (t.name = 'Construction A'  AND u.name = 'Carl Construction')
ON CONFLICT DO NOTHING;

-- Jobs
INSERT INTO jobs (name, status, created_by)
SELECT '123 Main St Water Loss',  'open',   id FROM users WHERE name = 'Alex Admin' LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO jobs (name, status, created_by)
SELECT '456 Oak Ave Fire Damage', 'open',   id FROM users WHERE name = 'Alex Admin' LIMIT 1
ON CONFLICT DO NOTHING;

INSERT INTO jobs (name, status, created_by)
SELECT '789 Pine Rd Completed',   'closed', id FROM users WHERE name = 'Alex Admin' LIMIT 1
ON CONFLICT DO NOTHING;

-- Notification config defaults (also created lazily by getNotifyConfig()'s
-- built-in defaults — this seed is a convenience, not a hard dependency).
INSERT INTO app_config (key, value) VALUES
  ('notify_enabled', '1'),
  ('notify_poll_interval_min', '5'),
  ('notify_checkout_idle_min', '15')
ON CONFLICT (key) DO NOTHING;
