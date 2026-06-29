import type { SqlDb } from '../types';

export const migration = {
  version: 9,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE locations ADD COLUMN latitude REAL`);
    db.executeSync(`ALTER TABLE locations ADD COLUMN longitude REAL`);
    db.executeSync(`ALTER TABLE activity_log ADD COLUMN latitude REAL`);
    db.executeSync(`ALTER TABLE activity_log ADD COLUMN longitude REAL`);
    db.executeSync(`ALTER TABLE activity_log ADD COLUMN location_accuracy REAL`);
  },
};
