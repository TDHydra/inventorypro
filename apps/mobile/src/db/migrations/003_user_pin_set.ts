import { DB } from '@op-engineering/op-sqlite';

export const migration = {
  version: 3,
  up: (db: DB): void => {
    // Tracks whether the user has set their own PIN (false = prompt on first login).
    db.executeSync(`ALTER TABLE users ADD COLUMN pin_set INTEGER NOT NULL DEFAULT 0`);
    // Existing synced users already had PINs; default them to set. The server's
    // next pull will correct this for any that are genuinely unset.
    db.executeSync(`UPDATE users SET pin_set = 1`);
  },
};
