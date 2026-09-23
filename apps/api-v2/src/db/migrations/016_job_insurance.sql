-- Migration 016: P5 5c — job insurance carrier.
-- jobs.insurance_carrier is the insurance company/carrier name, distinct from
-- jobs.reference_number which holds the insurance claim #/customer PO.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS insurance_carrier TEXT;
