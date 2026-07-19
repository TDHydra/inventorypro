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
