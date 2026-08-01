import { WIDGET_REGISTRY, type WidgetType, type LayoutBlock } from './widgets';
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

// Whether ONE role would see a given block on its resolved dashboard (#192
// view-as-role preview): mirrors filterTilesForRoles' single-role case, but
// works over a Layout block (tile OR non-tile — activity-preview carries a
// requiredPermission too) rather than a tile list. A block with no
// requiredPermission (data-driven blocks like low-stock/quick-add/the #144
// contextual actions) is always considered visible here — this preview is a
// PERMISSION preview, not a full data-driven visibility simulation. Takes the
// same roleHasPerm predicate as filterTilesForRoles (DI, not a direct
// roleHasPermission import) so this stays pure/DB-free and unit-testable; the
// real call site passes roleHasPermission from src/auth/permissions.
export function blockVisibleForRole(
  block: LayoutBlock,
  role: string,
  roleHasPerm: (role: string, perm: Permission) => boolean,
): boolean {
  const perm = WIDGET_REGISTRY[block.widget].requiredPermission;
  if (!perm) return true;
  return roleHasPerm(role, perm);
}
