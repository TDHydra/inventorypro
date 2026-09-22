// One-time wiring of @invenpro/core's injection seams. Must run before any
// core sync/db module is USED (config is read at call time, so importing is
// safe in any order — only calls need the config present). The root layout
// calls bootCore() at module scope, ahead of its initDb() effect.
import { configureCore, registerAfterPull } from '@invenpro/core';
import { generateUUID } from './utils/uuid';
import { getValidJwt, revalidateSession, getSavedUserId } from './auth/session';
import { assertWritable } from './db/maintenance';
import { loadRolePermissionCache } from './auth/permissions';
import { reconcileTeams } from './repos/teams';
import { track } from './telemetry';

let booted = false;

export function bootCore(): void {
  if (booted) return;
  booted = true;

  configureCore({
    apiBase: process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000',
    generateUUID,
    auth: { getValidJwt, revalidateSession, getSavedUserId },
    assertWritable,
    track,
  });

  // Post-pull refreshers (the old engine.ts hardcoded block, now a registry).
  // Wave surfaces register their own caches next to their repos; the skeleton
  // needs only the permission cache so gated UI reacts to synced role edits.
  registerAfterPull({
    name: 'rolePermissions',
    tables: ['role_settings'],
    run: () => loadRolePermissionCache(),
  });

  // No `tables` filter — must run every pull cycle (own internal 60-min
  // throttle via app_settings), mirroring the old engine's hardcoded
  // `await reconcileTeams()` on every runDrainAndPull(). See
  // src/repos/teams.ts's reconcileTeams doc comment for why.
  registerAfterPull({
    name: 'reconcileTeams',
    run: async () => { await reconcileTeams(); },
  });
}
