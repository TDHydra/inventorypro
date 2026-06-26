import React from 'react';
import { usePermission } from '../hooks/usePermission';
import { Permission } from '../constants/roles';

interface Props {
  permission: Permission;
  teamId?: string | null;
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * Renders children only if the current user has the given permission.
 * Pass fallback to show something instead (default: null = nothing shown).
 */
export function PermissionGate({ permission, teamId, children, fallback = null }: Props) {
  const allowed = usePermission(permission, teamId);
  return allowed ? <>{children}</> : <>{fallback}</>;
}
