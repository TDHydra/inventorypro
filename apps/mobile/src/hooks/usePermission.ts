import { useSession } from './useSession';
import { hasPermission } from '../auth/permissions';
import { Permission } from '../constants/roles';

export function usePermission(permission: Permission, teamId?: string | null): boolean {
  const { user } = useSession();
  if (!user) return false;
  return hasPermission(user, permission, teamId);
}
