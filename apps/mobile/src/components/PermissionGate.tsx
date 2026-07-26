import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { usePermission } from '../hooks/usePermission';
import { Permission, PERMISSION_LABELS } from '../constants/roles';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';

interface Props {
  permission: Permission;
  teamId?: string | null;
  children: React.ReactNode;
  fallback?: React.ReactNode;
  /**
   * 'hide' (default, backward compatible): render `fallback` (default null)
   * when denied — the control disappears entirely.
   * 'disable': render `children` anyway, dimmed and inert (`pointerEvents:
   * 'none'`), with a one-line "Requires <label>" reason underneath — so users
   * learn why instead of hitting a silent no-op or a sync conflict (#76).
   * Generalizes the {editable, reason} shape roles.tsx already renders for
   * per-permission role-editor cells.
   */
  mode?: 'hide' | 'disable';
}

/**
 * Renders children only if the current user has the given permission.
 * Pass fallback to show something instead (default: null = nothing shown).
 */
export function PermissionGate({ permission, teamId, children, fallback = null, mode = 'hide' }: Props) {
  const allowed = usePermission(permission, teamId);
  const s = useThemedStyles(makeStyles);

  if (allowed) return <>{children}</>;
  if (mode === 'hide') return <>{fallback}</>;

  return (
    <View>
      <View style={s.disabledContent} pointerEvents="none">
        {children}
      </View>
      <Text style={s.reason}>Requires {PERMISSION_LABELS[permission]}</Text>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // Children can be arbitrary controls (buttons, switches, inputs) with their
  // own colors, so "reduced emphasis" is expressed as opacity rather than a
  // literal textDisabled recolor — the same 0.5 dim already used for disabled
  // buttons/rows across the app (PrimaryButton, BulkActionBar, pickers).
  disabledContent: { opacity: 0.5 },
  reason: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 2 },
});
