-- Migration 068: payer taxonomy for fuel receipts (#168 follow-up).
-- The gas-receipt "For" picker only offered teams + open jobs, so a fuel-up
-- charged to the office (or any non-team, non-job payer) could not be saved —
-- the required field dead-ended the flow. Payers become a managed taxonomy
-- category ('payer', editable in Manage Types like every other type list) and
-- the picker merges them in alongside teams and jobs. No schema change:
-- vehicle_service_records.payer is already a TEXT snapshot of the chosen name.
--
-- Seeds carry updated_at = NOW() explicitly so already-enrolled devices receive
-- them via incremental /sync/pull (the seed-sync watermark trap, per 048).

INSERT INTO taxonomy_types (category, label, icon, sort_order, updated_at)
SELECT 'payer', 'Office', '🏢', 0, NOW()
WHERE NOT EXISTS (SELECT 1 FROM taxonomy_types WHERE category = 'payer' AND label = 'Office');
