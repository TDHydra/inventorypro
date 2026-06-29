import type { SqlDb } from '../types';

export const migration = {
  version: 8,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE jobs ADD COLUMN job_number TEXT`);
    db.executeSync(`ALTER TABLE jobs ADD COLUMN customer_name TEXT`);
    db.executeSync(`ALTER TABLE jobs ADD COLUMN site_address TEXT`);
    db.executeSync(`ALTER TABLE jobs ADD COLUMN site_location_id TEXT`);
    db.executeSync(`ALTER TABLE jobs ADD COLUMN description TEXT`);
  },
};
