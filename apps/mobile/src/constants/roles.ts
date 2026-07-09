export type UserRole =
  | 'full_admin'
  | 'franchise_manager'
  | 'hr_manager'
  | 'office_manager'
  | 'head_of_construction'
  | 'head_of_contents'
  | 'production_manager'
  | 'carpet_cleaning_manager'
  | 'construction_crew'
  | 'contents_crew'
  | 'mitigation_technician'
  | 'carpet_cleaning_crew'
  | 'temporary_employee';

export type Permission =
  | 'checkout_inventory'
  | 'checkin_inventory'
  | 'add_inventory'
  | 'quick_add'
  | 'edit_inventory'
  | 'delete_inventory'
  | 'transfer_between_locations'
  | 'create_jobs'
  | 'close_jobs'
  | 'manage_locations'
  | 'upload_media'
  | 'edit_media'
  | 'delete_media'
  | 'view_all_logs'
  | 'view_own_logs'
  | 'view_team_activity'
  | 'manage_teams'
  | 'checkout_for_team'
  | 'manage_users'
  | 'set_pins'
  | 'manage_roles_permissions'
  | 'view_financial_data'
  | 'system_settings'
  | 'view_audit_log'
  | 'send_notifications';

export const ROLE_TIER: Record<UserRole, 1 | 2 | 3 | 4> = {
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

// ── Hierarchy guards (client-side UX mirror of the server's authoritative rule) ──
// Effective tier: full_admin is a true APEX (5) — above every other role, INCLUDING
// its tier-4 peer franchise_manager — so only a full_admin can act on/assign a
// full_admin. `missing` is the fail-closed fallback for unknown/legacy roles (a
// weak 0 for the caller, a strong 4 for the target) so guards deny by default.
function effectiveTier(role: UserRole, missing: number): number {
  if (role === 'full_admin') return 5;
  return ROLE_TIER[role] ?? missing;
}

// A caller may act on a target only at or below their OWN effective tier — never above.
export function canActOnTarget(callerRole: UserRole, targetRole: UserRole): boolean {
  return effectiveTier(callerRole, 0) >= effectiveTier(targetRole, 4);
}

// A caller may assign a role only at or below their own effective tier (can't grant a
// role at/above their own authority — e.g. only a full_admin can assign full_admin).
export function canAssignRole(callerRole: UserRole, newRole: UserRole): boolean {
  return effectiveTier(newRole, 4) <= effectiveTier(callerRole, 0);
}

export const PIN_LENGTH_BY_TIER: Record<1 | 2 | 3 | 4, number> = {
  1: 4,
  2: 6,
  3: 6,
  4: 8,
};

export const ROLE_DISPLAY_NAMES: Record<UserRole, string> = {
  full_admin:               'Full Admin',
  franchise_manager:        'Franchise Manager/Owner',
  hr_manager:               'HR Manager',
  office_manager:           'Office Manager',
  head_of_construction:     'Head of Construction',
  head_of_contents:         'Head of Contents',
  production_manager:       'Production Manager',
  carpet_cleaning_manager:  'Carpet Cleaning Manager',
  construction_crew:        'Construction Crew',
  contents_crew:            'Contents Crew',
  mitigation_technician:    'Mitigation Technician',
  carpet_cleaning_crew:     'Carpet Cleaning Crew',
  temporary_employee:       'Temporary Employee',
};

// Curated colors readable as text on light surfaces (white / colors.surface).
// Used both as the admin swatch palette and as the per-role defaults below.
export const ROLE_COLOR_PALETTE: string[] = [
  '#C62828', '#AD1457', '#6A1B9A', '#4527A0', '#283593',
  '#1565C0', '#00838F', '#00695C', '#2E7D32', '#558B2F',
  '#EF6C00', '#5D4037', '#37474F', '#455A64',
];

// Neutral readable fallback (matches colors.textPrimary) for unknown/legacy roles.
export const ROLE_COLOR_FALLBACK = '#1E293B';

// Per-role default name color. Distinct, drawn from ROLE_COLOR_PALETTE. Admins
// can override per role (role_settings.color); NULL override → these defaults.
export const ROLE_COLORS: Record<UserRole, string> = {
  full_admin:               '#C62828',
  franchise_manager:        '#6A1B9A',
  hr_manager:               '#AD1457',
  office_manager:           '#283593',
  head_of_construction:     '#EF6C00',
  head_of_contents:         '#5D4037',
  production_manager:       '#1565C0',
  carpet_cleaning_manager:  '#00695C',
  construction_crew:        '#37474F',
  contents_crew:            '#00838F',
  mitigation_technician:    '#4527A0',
  carpet_cleaning_crew:     '#558B2F',
  temporary_employee:       '#455A64',
};

// Effective name color for a role: explicit override → role default → neutral.
export function resolveRoleColor(role: string, override?: string | null): string {
  const o = override?.trim();
  if (o) return o;
  return ROLE_COLORS[role as UserRole] ?? ROLE_COLOR_FALLBACK;
}

type PermissionMap = Record<Permission, boolean>;

const tier4: PermissionMap = {
  checkout_inventory:        true,
  checkin_inventory:         true,
  add_inventory:             true,
  quick_add:                 true,
  edit_inventory:            true,
  delete_inventory:          true,
  transfer_between_locations:true,
  create_jobs:               true,
  close_jobs:                true,
  manage_locations:          true,
  upload_media:              true,
  edit_media:                true,
  delete_media:              true,
  view_all_logs:             true,
  view_own_logs:             true,
  view_team_activity:        true,
  manage_teams:              true,
  checkout_for_team:         true,
  manage_users:              true,
  set_pins:                  true,
  manage_roles_permissions:  true,
  view_financial_data:       true,
  system_settings:           true,
  view_audit_log:           true,
  send_notifications:        true,
};

const tier3: PermissionMap = {
  checkout_inventory:        false,
  checkin_inventory:         false,
  add_inventory:             false,
  quick_add:                 true,
  edit_inventory:            false,
  delete_inventory:          false,
  transfer_between_locations:false,
  create_jobs:               true,
  close_jobs:                true,
  manage_locations:          false,
  upload_media:              true,
  edit_media:                false,
  delete_media:              false,
  view_all_logs:             true,
  view_own_logs:             true,
  view_team_activity:        true,
  manage_teams:              false,
  checkout_for_team:         false,
  manage_users:              true,
  set_pins:                  true,
  manage_roles_permissions:  false,
  view_financial_data:       true,
  system_settings:           false,
  view_audit_log:           false,
  send_notifications:        true,
};

const tier2: PermissionMap = {
  checkout_inventory:         true,
  checkin_inventory:          true,
  add_inventory:              true,
  quick_add:                  true,
  edit_inventory:             true,
  delete_inventory:           false,
  transfer_between_locations: true,
  create_jobs:                true,
  close_jobs:                 true,
  manage_locations:           true,
  upload_media:               true,
  edit_media:                 true,
  delete_media:               false,
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
  quick_add:                  false,
  edit_inventory:             false,
  delete_inventory:           false,
  transfer_between_locations: false,
  create_jobs:                false,
  close_jobs:                 false,
  manage_locations:           false,
  upload_media:               true,
  edit_media:                 false,
  delete_media:               false,
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
  edit_media:         false,
  delete_media:       false,
  checkout_for_team:  false,
};

export const ROLE_DEFAULTS: Record<UserRole, PermissionMap> = {
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
