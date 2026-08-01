import { WIDGET_REGISTRY, type WidgetType } from './widgets';
import type { Permission } from '../constants/roles';

// Which tile widgets the preset editor should OFFER for a preset assigned to
// `targetRoles` (#122 Phase B): a tile is offered when it carries no
// requiredPermission, when the preset has no role assignments yet, or when
// EVERY assigned role passes the tile's requiredPermission. Purely advisory —
// the hub's PermissionGate stays as the runtime backstop.
export function filterTilesForRoles(
  tiles: WidgetType[],
  targetRoles: string[],
  roleHasPerm: (role: string, perm: Permission) => boolean,
): WidgetType[] {
  if (targetRoles.length === 0) return tiles;
  return tiles.filter(w => {
    const perm = WIDGET_REGISTRY[w].requiredPermission;
    if (!perm) return true;
    return targetRoles.every(r => roleHasPerm(r, perm));
  });
}

// Personal dashboard editor variant (#193): filters the "add widget" picker to
// tiles the CURRENT USER's own permissions allow, rather than every assigned
// role (filterTilesForRoles is the admin preset-editor version, which checks
// role permissions since a preset targets roles, not one person). A tile with
// no requiredPermission is always offered — same data-driven-access idiom as
// fast-checkout/manage-my-team. PermissionGate on the dashboard screen stays
// the runtime backstop either way.
export function filterTilesForUser(
  tiles: WidgetType[],
  hasPerm: (perm: Permission) => boolean,
): WidgetType[] {
  return tiles.filter(w => {
    const perm = WIDGET_REGISTRY[w].requiredPermission;
    return !perm || hasPerm(perm);
  });
}
