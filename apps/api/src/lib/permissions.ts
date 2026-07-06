import { FastifyRequest, FastifyReply } from 'fastify';

// KEEP IN SYNC with apps/mobile/src/constants/roles.ts

type PermissionMap = Record<string, boolean>;

// Self-lockout floor: full_admin ALWAYS retains the permissions needed to
// recover/manage the system, regardless of any role/user override. Authoritative
// (not just UI-disabled) so a stray override in role_settings can never lock
// everyone out of permission management. KEEP IN SYNC with mobile.
const FULL_ADMIN_FLOOR = new Set(['manage_roles_permissions', 'system_settings']);

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
