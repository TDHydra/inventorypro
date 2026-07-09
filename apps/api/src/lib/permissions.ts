import { FastifyRequest, FastifyReply } from 'fastify';

// KEEP IN SYNC with apps/mobile/src/constants/roles.ts

type PermissionMap = Record<string, boolean>;

// Self-lockout floor: full_admin ALWAYS retains the permissions needed to
// recover/manage the system, regardless of any role/user override. Authoritative
// (not just UI-disabled) so a stray override in role_settings can never lock
// everyone out of permission management. KEEP IN SYNC with mobile.
const FULL_ADMIN_FLOOR = new Set(['manage_roles_permissions', 'system_settings']);

// Authority tier per role (1 = crew … 4 = admin). KEEP IN SYNC with
// apps/mobile/src/constants/roles.ts (ROLE_TIER). Security-critical: nobody may
// modify or assign a role/permission at a tier strictly ABOVE their own. These
// two helpers are the single source of truth for that rule across every write
// path — they FAIL CLOSED (unknown/missing caller → tier 0 → can act on nobody;
// unknown target/new role → treated as the top tier → denied).
export const ROLE_TIER: Record<string, 1 | 2 | 3 | 4> = {
  temporary_employee:       1,
  carpet_cleaning_crew:     1,
  mitigation_technician:    1,
  contents_crew:            1,
  construction_crew:        1,
  carpet_cleaning_manager:  2,
  production_manager:       2,
  head_of_contents:         2,
  head_of_construction:     2,
  office_manager:           3,
  hr_manager:               3,
  franchise_manager:        4,
  full_admin:               4,
};

// Effective authority tier used for ALL comparisons. full_admin is a true APEX
// (tier 5) — strictly above every other role, INCLUDING its tier-4 peer
// franchise_manager — so only a full_admin may ever modify or assign a
// full_admin. Every other role compares by its normal 1..4 ROLE_TIER. Returns
// undefined for unknown roles so callers can fail closed. KEEP IN SYNC with mobile.
export function effectiveTier(role: string | null | undefined): number | undefined {
  if (role === 'full_admin') return 5;
  return role != null ? ROLE_TIER[role] : undefined;
}

// May `callerRole` act on a target holding `targetRole`? True only when the
// caller's effective tier is >= the target's (act on peers or below, NEVER
// above). Unknown/missing caller → tier 0 (acts on nobody). Unknown target →
// tier 4 (deny — fail closed). full_admin is apex: only a full_admin can act on
// a full_admin; a franchise_manager (tier 4) cannot.
export function canActOnTarget(callerRole: string | null | undefined, targetRole: string | null | undefined): boolean {
  const callerTier = effectiveTier(callerRole) ?? 0;
  const targetTier = effectiveTier(targetRole) ?? 4;
  return callerTier >= targetTier;
}

// May `callerRole` create/assign `newRole`? True only when the new role's
// effective tier is <= the caller's (can't mint a role above your own). Unknown
// newRole → deny (fail closed). Unknown/missing caller → tier 0 (can assign
// nothing). full_admin is apex: only a full_admin can assign the full_admin role.
export function canAssignRole(callerRole: string | null | undefined, newRole: string | null | undefined): boolean {
  const newTier = effectiveTier(newRole);
  if (newTier === undefined) return false; // unknown role → deny
  const callerTier = effectiveTier(callerRole) ?? 0;
  return newTier <= callerTier;
}

const tier4: PermissionMap = {
  checkout_inventory:         true,
  checkin_inventory:          true,
  add_inventory:              true,
  edit_inventory:             true,
  delete_inventory:           true,
  transfer_between_locations: true,
  create_jobs:                true,
  close_jobs:                 true,
  manage_locations:           true,
  upload_media:               true,
  view_all_logs:              true,
  view_own_logs:              true,
  view_team_activity:         true,
  manage_teams:               true,
  checkout_for_team:          true,
  manage_users:               true,
  set_pins:                   true,
  manage_roles_permissions:   true,
  view_financial_data:        true,
  system_settings:            true,
  view_audit_log:            true,
  send_notifications:         true,
};

const tier3: PermissionMap = {
  checkout_inventory:         false,
  checkin_inventory:          false,
  add_inventory:              false,
  edit_inventory:             false,
  delete_inventory:           false,
  transfer_between_locations: false,
  create_jobs:                true,
  close_jobs:                 true,
  manage_locations:           false,
  upload_media:               true,
  view_all_logs:              true,
  view_own_logs:              true,
  view_team_activity:         true,
  manage_teams:               false,
  checkout_for_team:          false,
  manage_users:               true,
  set_pins:                   true,
  manage_roles_permissions:   false,
  view_financial_data:        true,
  system_settings:            false,
  view_audit_log:            false,
  send_notifications:         true,
};

const tier2: PermissionMap = {
  checkout_inventory:         true,
  checkin_inventory:          true,
  add_inventory:              true,
  edit_inventory:             true,
  delete_inventory:           false,
  transfer_between_locations: true,
  create_jobs:                true,
  close_jobs:                 true,
  manage_locations:           true,
  upload_media:               true,
  view_all_logs:              true,
  view_own_logs:              true,
  view_team_activity:         true,
  manage_teams:               true,
  checkout_for_team:          true,
  manage_users:               false,
  set_pins:                   false,
  manage_roles_permissions:   false,
  view_financial_data:        false,
  system_settings:            false,
  view_audit_log:            false,
  send_notifications:         false,
};

const tier1: PermissionMap = {
  checkout_inventory:         true,
  checkin_inventory:          true,
  add_inventory:              false,
  edit_inventory:             false,
  delete_inventory:           false,
  transfer_between_locations: false,
  create_jobs:                false,
  close_jobs:                 false,
  manage_locations:           false,
  upload_media:               true,
  view_all_logs:              false,
  view_own_logs:              true,
  view_team_activity:         false,
  manage_teams:               false,
  checkout_for_team:          true,
  manage_users:               false,
  set_pins:                   false,
  manage_roles_permissions:   false,
  view_financial_data:        false,
  system_settings:            false,
  view_audit_log:            false,
  send_notifications:         false,
};

const tempEmployee: PermissionMap = {
  ...tier1,
  checkin_inventory:  false,
  upload_media:       false,
  checkout_for_team:  false,
};

export const ROLE_DEFAULTS: Record<string, PermissionMap> = {
  full_admin:               tier4,
  franchise_manager:        tier4,
  hr_manager:               tier3,
  office_manager:           { ...tier3, view_financial_data: true },
  head_of_construction:     tier2,
  head_of_contents:         tier2,
  production_manager:       tier2,
  carpet_cleaning_manager:  tier2,
  construction_crew:        tier1,
  contents_crew:            tier1,
  mitigation_technician:    tier1,
  carpet_cleaning_crew:     tier1,
  temporary_employee:       tempEmployee,
};

// Resolution order (last match wins): ROLE_DEFAULTS → role override → user override.
// roleOverrides is the role_settings.permission_overrides deviation map (may be
// null when the role has no row / no deviations).
export function userHasPermission(
  role: string,
  userOverrides: Record<string, boolean> | null,
  perm: string,
  roleOverrides?: Record<string, boolean> | null,
): boolean {
  // 0. Self-lockout floor — full_admin can never lose these (overrides ignored).
  if (role === 'full_admin' && FULL_ADMIN_FLOOR.has(perm)) return true;
  // 1. Role default
  let result = ROLE_DEFAULTS[role]?.[perm] ?? false;
  // 2. Role-level override (runtime deviation from ROLE_DEFAULTS)
  if (roleOverrides && perm in roleOverrides) result = !!roleOverrides[perm];
  // 3. User override (always wins)
  if (userOverrides && perm in userOverrides) result = !!userOverrides[perm];
  return result;
}

export function requirePermission(perm: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const userId = (request.user as { sub: string }).sub;
    const { rows } = await (request.server as any).pg.query(
      `SELECT u.role, u.permission_overrides, rs.permission_overrides AS role_overrides
         FROM users u
         LEFT JOIN role_settings rs ON rs.role = u.role
        WHERE u.id = $1`,
      [userId],
    );
    const u = rows[0];
    if (!u || !userHasPermission(u.role, u.permission_overrides, perm, u.role_overrides)) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
  };
}
