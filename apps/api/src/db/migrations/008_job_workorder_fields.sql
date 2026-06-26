ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_number TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS customer_name TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS site_address TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS site_location_id UUID REFERENCES locations(id);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS description TEXT;

CREATE SEQUENCE IF NOT EXISTS jobs_job_number_seq;

CREATE OR REPLACE FUNCTION assign_job_number() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.job_number IS NULL THEN
    NEW.job_number := nextval('jobs_job_number_seq')::text;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_assign_job_number ON jobs;
CREATE TRIGGER trg_assign_job_number BEFORE INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION assign_job_number();
