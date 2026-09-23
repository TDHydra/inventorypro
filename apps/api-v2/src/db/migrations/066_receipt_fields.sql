-- Migration 066: gas-receipt fields on service records (#168). Mirrors mobile 054.
-- A gas receipt is a type='fuel_up' service record — odometer/cost/history reuse.
--   payer:  'Teams' | 'Office' | ... from app_config key gas_receipt_payers
--           (adjustable list; TEXT, never a PG enum)
--   job_id: optional job, soft FK (style of vehicle_checkouts.job_id — no constraint)
-- Both nullable; existing records untouched (no backfill, no watermark bump).
ALTER TABLE vehicle_service_records ADD COLUMN IF NOT EXISTS payer TEXT;
ALTER TABLE vehicle_service_records ADD COLUMN IF NOT EXISTS job_id UUID;
