import { FastifyRequest, FastifyReply } from 'fastify';
import { TEAM_OVERRIDABLE_PERMISSIONS } from './syncPolicy';

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

// Permissions whose GRANT/REVOKE is restricted to full_admin regardless of the
// caller's tier, because deletion is destructive. KEEP IN SYNC with the
// role_settings write guard in routes/sync.ts (the `['delete_inventory',
// 'delete_media']` list) and the client lock in
// apps/mobile/app/(app)/(admin)/roles.tsx.
export const FULL_ADMIN_ONLY_GRANT = new Set(['delete_inventory', 'delete_media']);

// Result of the pre-flight editability check for a single role→permission cell.
// `editable` mirrors exactly what the server would accept on a role_settings
// write; `reason` is a short human-readable explanation the editor can surface
// on a disabled toggle when editable === false.
export type PermissionEditability =
  | { editable: true; reason: null }
  | { editable: false; reason: string };

// Aggregate pre-flight preview for one target role's whole permission matrix.
export interface RolePermissionPreview {
  role: string;
  // Tier guard only: may the caller edit ANYTHING on this role's matrix? False
  // when the target role is at/above the caller's effective tier. When false,
  // `roleReason` explains why and every entry in `permissions` is non-editable.
  canEditRole: boolean;
  roleReason: string | null;
  // Per-permission editability, keyed by permission id, in the order supplied.
  permissions: Record<string, PermissionEditability>;
}

// Pre-flight: may `callerRole` toggle permission `perm` on `targetRole`'s matrix?
// This is the single source of truth the editor consumes to hide/disable toggles
// *before* the user tries, instead of failing on the write. It mirrors — in the
// same order — the three checks the server enforces for a role_settings push
// (routes/sync.ts): (1) tier guard via canActOnTarget, (2) the full_admin
// self-lockout floor (those bits are forced ON and non-toggleable for full_admin),
// (3) the full_admin-only destructive delete grant. Fails closed on unknown roles
// exactly as canActOnTarget does. Holding `manage_roles_permissions` is a separate
// precondition to reaching the editor at all and is intentionally NOT re-checked here.
export function canEditRolePermission(
  callerRole: string | null | undefined,
  targetRole: string | null | undefined,
  perm: string,
): PermissionEditability {
  // 1. Tier guard — caller must be at/above the target role's effective tier.
  if (!canActOnTarget(callerRole, targetRole)) {
    return { editable: false, reason: 'This role is at or above your access level.' };
  }
  // 2. Self-lockout floor — full_admin can never lose these (forced ON).
  if (targetRole === 'full_admin' && FULL_ADMIN_FLOOR.has(perm)) {
    return { editable: false, reason: 'Required for full admin.' };
  }
  // 3. Destructive grant — only a full_admin may grant/revoke delete permissions.
  if (FULL_ADMIN_ONLY_GRANT.has(perm) && callerRole !== 'full_admin') {
    return { editable: false, reason: 'Only a full admin can grant this.' };
  }
  return { editable: true, reason: null };
}

// Aggregate the per-permission preview for a whole role, plus the role-level tier
// gate. `perms` is the list of permission ids shown in the editor. Pure — safe to
// call from either the API or (mirrored) the mobile client to drive the UI.
export function previewRolePermissions(
  callerRole: string | null | undefined,
  targetRole: string | null | undefined,
  perms: readonly string[],
): RolePermissionPreview {
  const canEditRole = canActOnTarget(callerRole, targetRole);
  const permissions: Record<string, PermissionEditability> = {};
  for (const perm of perms) {
    permissions[perm] = canEditRolePermission(callerRole, targetRole, perm);
  }
  return {
    role: targetRole ?? '',
    canEditRole,
    roleReason: canEditRole ? null : 'This role is at or above your access level.',
    permissions,
  };
}

const tier4: PermissionMap = {
  checkout_inventory:         true,
  checkin_inventory:          true,
  add_inventory:              true,
  // #76: quick_add — KEEP IN SYNC with apps/mobile/src/constants/roles.ts tier maps.
  quick_add:                  true,
  edit_inventory:             true,
  delete_inventory:           true,
  transfer_between_locations: true,
  // #162: manage inventory inside a Vehicle/Locker UNIT owned by a user on a
  // team the actor does NOT share. Tier-4 only by default. KEEP IN SYNC with
  // apps/mobile/src/constants/roles.ts.
  manage_other_team_inventory: true,
  create_jobs:                true,
  close_jobs:                 true,
  manage_locations:           true,
  upload_media:               true,
  edit_media:                 true,
  delete_media:               true,
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
  quick_add:                  true,
  edit_inventory:             false,
  delete_inventory:           false,
  transfer_between_locations: false,
  manage_other_team_inventory: false,
  create_jobs:                true,
  close_jobs:                 true,
  manage_locations:           false,
  upload_media:               true,
  edit_media:                 false,
  delete_media:               false,
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
  quick_add:                  true,
  edit_inventory:             true,
  delete_inventory:           false,
  transfer_between_locations: true,
  manage_other_team_inventory: false,
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
  manage_other_team_inventory: false,
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
  // #76: explicit byte-parity with apps/mobile/src/constants/roles.ts (:261-268)
  // — mobile lists these explicitly even though tier1 already defaults both to
  // false; kept explicit here so the two source files stay comparable line-for-line.
  edit_media:         false,
  delete_media:       false,
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

// Resolution order (last match wins): ROLE_DEFAULTS → role override → team
// override union → user override. roleOverrides is the role_settings.
// permission_overrides deviation map (may be null when the role has no row /
// no deviations).
//
// #76 team-override union layer (the root-cause fix): mobile's hasPermission
// resolves a SINGLE active team context — role default → role override → THAT
// team's override (may grant OR deny) → global user override (always wins).
// The server has no equivalent "active team" per push entry (an outbox entry
// carries no team context), so exact parity is impossible. Instead it accepts
// the UNION of every team the caller belongs to: for perms on the
// TEAM_OVERRIDABLE_PERMISSIONS allowlist, a POSITIVE grant (=== true) in ANY
// one of the caller's teams is enough. A negative override in a team is never
// applied — it can't narrow access, only a grant elsewhere can widen it.
// Documented asymmetry: this makes the server's check a superset of what any
// single client team-context could show (client could show it enabled in team
// T ⇒ server also accepts it), and it can never be MORE restrictive than the
// role/user baseline. teamOverridesList is every team_members row's
// team_permission_overrides for the caller (order irrelevant).
export function userHasPermission(
  role: string,
  userOverrides: Record<string, boolean> | null,
  perm: string,
  roleOverrides?: Record<string, boolean> | null,
  teamOverridesList?: Array<Record<string, boolean> | null> | null,
): boolean {
  // 0. Self-lockout floor — full_admin can never lose these (overrides ignored).
  if (role === 'full_admin' && FULL_ADMIN_FLOOR.has(perm)) return true;
  // 1. Role default
  let result = ROLE_DEFAULTS[role]?.[perm] ?? false;
  // 2. Role-level override (runtime deviation from ROLE_DEFAULTS)
  if (roleOverrides && perm in roleOverrides) result = !!roleOverrides[perm];
  // 3. Team-override union — grants only (see comment above).
  if (TEAM_OVERRIDABLE_PERMISSIONS.has(perm) && teamOverridesList) {
    for (const teamOverrides of teamOverridesList) {
      if (teamOverrides && teamOverrides[perm] === true) { result = true; break; }
    }
  }
  // 4. User override (always wins — even over a team grant, matching mobile's
  // "global user override always wins" precedence).
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
