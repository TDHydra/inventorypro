import type { SqlDb } from '../types';

// Migration 065: two more self-service user_prefs columns (#245/#246). Mirrors
// API migration 079. Both are genuinely NULL-for-everyone-until-written — no
// backfill, no watermark touch needed (house rule 6 only applies when a
// migration changes existing row DATA other devices need to see).
//
// notification_prefs TEXT — JSON map { category: boolean } (#245, "My
// Notifications"). Missing key or missing row = enabled (opt-out model, so
// shipping this feature changes nobody's delivery by default). See
// db/userPrefs.ts's getNotificationPrefs/setNotificationCategoryPref.
//
// onboarding_checklist TEXT — JSON { status: 'pending' | 'dismissed' } (#246,
// first-login checklist). Stays NULL forever for every user who already
// existed at migration time; only login.tsx's submitSetPin success branch
// ever writes 'pending' (NOT the first-launch/full-download path — a
// re-enrolled veteran on a replacement device must never see this). See
// db/userPrefs.ts's getOnboardingChecklist/startOnboardingChecklist/
// dismissOnboardingChecklist.
//
// SYNCED columns (docs/SYNC-MIGRATION-CHECKLIST.md): pull.ts TABLE_UPSERT_SQL
// + rowToValues extended in the same change, plus syncPolicy's user_prefs
// projection (~L581).
export const migration = {
  version: 65,
  up: (db: SqlDb): void => {
    db.executeSync(`ALTER TABLE user_prefs ADD COLUMN notification_prefs TEXT`);
    db.executeSync(`ALTER TABLE user_prefs ADD COLUMN onboarding_checklist TEXT`);
  },
};
