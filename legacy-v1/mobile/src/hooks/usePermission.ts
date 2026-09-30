import { useSyncExternalStore } from 'react';
import { useSession } from './useSession';
import {
  hasPermission,
  subscribeRolePermissions,
  getRolePermissionsVersion,
} from '../auth/permissions';
import { Permission } from '../constants/roles';

export function usePermission(permission: Permission, teamId?: string | null): boolean {
  const { user } = useSession();
  // Subscribe to the role-permission cache so gated UI re-renders when role
  // overrides change (admin edit or sync) instead of showing stale permissions
  // until the next remount.
  useSyncExternalStore(
    subscribeRolePermissions,
    getRolePermissionsVersion,
    getRolePermissionsVersion,
  );
  if (!user) return false;
  return hasPermission(user, permission, teamId);
}
