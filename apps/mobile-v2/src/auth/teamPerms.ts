import type { Permission } from '../constants/roles';

// Permissions a team manager may override per-team (session.ts filters the
// synced team_permission_overrides JSON to this allowlist when building
// team_contexts). Must mirror apps/api/src/lib/syncPolicy.ts
// TEAM_OVERRIDABLE_PERMISSIONS. Lives here (not with the team queries, which
// arrive in Wave B) because the session builder needs it from day one.
export const TEAM_OVERRIDABLE_PERMISSIONS: Permission[] = [
  'checkout_inventory', 'checkin_inventory', 'add_inventory', 'quick_add',
  'edit_inventory', 'delete_inventory', 'transfer_between_locations',
  'create_jobs', 'close_jobs', 'manage_locations', 'upload_media',
  // edit_media yes, delete_media deliberately NO — its GRANT is full-admin-only
  // (the server role_settings guard), so a team manager must not be able to
  // mint it per-team either.
  'edit_media',
  'view_team_activity', 'checkout_for_team', 'view_financial_data',
];
