// Ported from apps/mobile/app/(app)/(admin)/roles.tsx.
//
// Import mapping applied (docs/REBUILD-PORTING.md):
//   '../../../src/db/queries/users' → '../../../src/repos/roleSettings'
//   '../../../src/db/tx' (runInTransaction) → '@invenpro/core'
//   '../../../src/sync/outbox' (appendOutbox) → dropped; every write here
//     self-mirrors via repos/roleSettings.ts (createRepository('role_settings')).
//   '../../../src/hooks/useDataVersion' (useTableVersion) → '@invenpro/core'
//   '../../../src/lib/themedAlert' (Alert), SelectField, confirmSheet,
//     ModalSheet, MaintenanceBanner, useTheme, useThemedStyles → '@invenpro/ui'
//
// Cut for this wave (dashboard preset engine is cut entirely per the
// coordinator's cut-list): the "Dashboard preset" SelectField section and its
// changeRolePreset/getRoleDashboardPresetIds/getDashboardPresets/
// loadDashboardCache wiring are removed. Everything else — min-PIN stepper,
// idle re-auth selector, color swatches, grouped/collapsible permission
// matrix with impact-preview confirms, and the "Preview as…" picker — is a
// straight port.
import { useState, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Switch, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import {
  ROLE_DISPLAY_NAMES, ROLE_TIER, ROLE_DEFAULTS, PIN_LENGTH_BY_TIER,
  UserRole, Permission, ROLE_COLOR_PALETTE, resolveRoleColor, canActOnTarget,
  PERMISSION_LABELS, PERMISSION_GROUPS, PERMISSION_GROUP_NAMES, PermissionGroupName,
} from '../../../src/constants/roles';
import {
  getRoleSettings, setRoleMinPin, getRolePermissionOverrides, setRolePermission,
  getRoleColorMap, setRoleColor, getRoleIdleReauthMinutes, setRoleIdleReauthMinutes,
} from '../../../src/repos/roleSettings';
import { getActiveUserCountByRole } from '../../../src/repos/users';
import { loadRolePermissionCache, canEditRolePermission } from '../../../src/auth/permissions';
import type { Theme } from '@invenpro/ui';
import {
  SelectField, confirmSheet, Alert, ModalSheet, MaintenanceBanner, useTheme, useThemedStyles,
} from '@invenpro/ui';
import { runInTransaction, useTableVersion } from '@invenpro/core';
import { appendLog } from '../../../src/db/queries/log';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';

const ALL_ROLES = Object.keys(ROLE_DISPLAY_NAMES) as UserRole[];

// Order roles by tier (highest authority first) so the list reads top-down.
const ROLES_BY_TIER = [...ALL_ROLES].sort((a, b) => ROLE_TIER[b] - ROLE_TIER[a] || a.localeCompare(b));

const PERMISSION_ORDER = Object.keys(PERMISSION_LABELS) as Permission[];

const MIN_PIN = 4;
const MAX_PIN = 8;

// Fixed idle re-auth presets (minutes). "0" = disabled — the DEFAULT for
// every role until an admin opts in.
const IDLE_REAUTH_OPTIONS = [
  { id: '0', label: 'Off' },
  { id: '5', label: '5 min' },
  { id: '15', label: '15 min' },
  { id: '30', label: '30 min' },
  { id: '60', label: '60 min' },
  { id: '120', label: '120 min' },
];

// Self-lockout guard: full_admin must always retain the keys to the kingdom, so
// these two are forced ON and non-toggleable for that role in the matrix.
const FULL_ADMIN_LOCKED: Permission[] = ['manage_roles_permissions', 'system_settings'];
function isLockedPerm(role: UserRole, perm: Permission): boolean {
  return role === 'full_admin' && FULL_ADMIN_LOCKED.includes(perm);
}

export default function RolesScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  // `user` is the EFFECTIVE identity (real, or real-with-previewed-role while
  // a preview is active) — every permission/capability check below stays on
  // it. `realUser` is the untouched signed-in identity — activity-log
  // attribution uses that so a preview never mis-attributes a write.
  const { user, realUser, previewRole, setPreviewRole } = useSession();
  const { locked } = useMaintenanceMode();
  const canManage = usePermission('manage_roles_permissions');
  const [previewPickerOpen, setPreviewPickerOpen] = useState(false);
  const version = useTableVersion(['role_settings']);
  const minPins = useMemo<Record<string, number>>(() => getRoleSettings(), [version]);
  const overrides = useMemo<Record<string, Record<string, boolean>>>(() => getRolePermissionOverrides(), [version]);
  const [expanded, setExpanded] = useState<string | null>(null);
  // Per-role, per-group collapse state for the grouped permission matrix,
  // keyed "<role>:<group>" so groups collapse independently across roles.
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  function toggleGroupExpanded(key: string) {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }
  const roleColors = useMemo<Record<string, string>>(() => getRoleColorMap(), [version]);
  const idleReauthMinutes = useMemo<Record<string, number>>(() => getRoleIdleReauthMinutes(), [version]);

  function effectivePerm(role: UserRole, perm: Permission): { value: boolean; modified: boolean } {
    const def = ROLE_DEFAULTS[role][perm];
    const ov = overrides[role];
    const modified = !!ov && perm in ov;
    return { value: modified ? ov[perm] : def, modified };
  }

  const grantedCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const role of ALL_ROLES) {
      out[role] = PERMISSION_ORDER.filter(p => {
        if (isLockedPerm(role, p)) return true;
        const ov = overrides[role];
        return ov && p in ov ? ov[p] : ROLE_DEFAULTS[role][p];
      }).length;
    }
    return out;
  }, [overrides]);

  function commitPermWrite(role: UserRole, perm: Permission, next: boolean, def: boolean) {
    // Toggling back to the default removes the override key (clean reset).
    // setRolePermission already mirrors the permission_overrides UPDATE to the
    // sync outbox internally — do NOT appendOutbox here or it double-syncs.
    setRolePermission(role, perm, next === def ? null : next);
    appendLog({
      action: 'role_permission_changed',
      entity_type: 'role_settings',
      // A role is identified by a string key (e.g. "hr_manager"), not a UUID,
      // so it can't go in the UUID entity_id column. Keep entity_id null;
      // carry the role in the note + metadata.
      entity_id: null,
      user_id: realUser?.id ?? null,
      note: `${role} · ${perm}: ${next === def ? 'reset to default' : next}`,
      team_id: null, from_location_id: null, to_location_id: null,
      quantity: null, unit: null, job_id: null, metadata: JSON.stringify({ role }), device_id: null,
    });
  }

  function impactMessage(role: UserRole, changedLabel: string): string {
    const count = getActiveUserCountByRole(role);
    const users = count === 1 ? '1 user' : `${count} users`;
    return `This changes ${changedLabel} for ${users} with the ${ROLE_DISPLAY_NAMES[role]} role. ` +
      `User- or team-level overrides may still apply for some of them.`;
  }

  async function togglePerm(role: UserRole, perm: Permission) {
    if (!canManage) return;
    if (isLockedPerm(role, perm)) return; // self-lockout guard
    // Only a full_admin may grant/revoke the destructive delete permissions
    // (mirrored + enforced server-side on the role_settings sync write).
    if ((perm === 'delete_inventory' || perm === 'delete_media') && user?.role !== 'full_admin') return;
    if (isWriteBlocked()) return;
    const def = ROLE_DEFAULTS[role][perm];
    const { value: cur } = effectivePerm(role, perm);
    const next = !cur;

    const ok = await confirmSheet({
      title: 'Change this permission?',
      message: impactMessage(role, PERMISSION_LABELS[perm]),
      confirmLabel: 'Change',
    });
    if (!ok) return;
    // Re-check after the await — maintenance mode or the role toggling closed
    // could have changed state while the sheet was showing.
    if (isWriteBlocked()) return;

    try {
      runInTransaction(() => commitPermWrite(role, perm, next, def));
    } catch (e) {
      Alert.alert('Could not update permission', e instanceof Error ? e.message : 'The change was not saved. Please try again.');
      return;
    }
    // Commit succeeded — refresh the permission cache so gates elsewhere see
    // the change; the overrides memo re-reads via the role_settings table version.
    loadRolePermissionCache();
  }

  // Group-level toggle-all: flips every EDITABLE, non-locked permission in the
  // group to the opposite of its current "all on" state, skipping
  // non-editable/locked cells silently. Shows exactly ONE combined confirm
  // listing every key that will actually change, then commits all of them in
  // a single transaction — never N sequential confirm sheets.
  async function toggleGroupAll(role: UserRole, group: PermissionGroupName) {
    if (!canManage) return;
    if (isWriteBlocked()) return;
    const callerRole = (user?.role ?? '') as UserRole;
    if (!canActOnTarget(callerRole, role)) return;

    const perms = PERMISSION_GROUPS[group];
    // canEditRolePermission already covers the tier guard, the full_admin
    // self-lockout floor, AND the full_admin-only destructive-grant rule.
    const editablePerms = perms.filter(p => canEditRolePermission(callerRole, role, p).editable);
    if (editablePerms.length === 0) return;

    const allOn = editablePerms.every(p => effectivePerm(role, p).value);
    const target = !allOn;
    const changed = editablePerms
      .map(p => ({ perm: p, def: ROLE_DEFAULTS[role][p] }))
      .filter(c => effectivePerm(role, c.perm).value !== target);
    if (changed.length === 0) return; // nothing would actually change

    const changedLabels = changed.map(c => PERMISSION_LABELS[c.perm]).join(', ');
    const ok = await confirmSheet({
      title: `${target ? 'Enable' : 'Disable'} all ${group} permissions?`,
      message: impactMessage(role, changedLabels),
      confirmLabel: target ? 'Enable all' : 'Disable all',
    });
    if (!ok) return;
    if (isWriteBlocked()) return;

    try {
      runInTransaction(() => {
        for (const c of changed) commitPermWrite(role, c.perm, target, c.def);
      });
    } catch (e) {
      Alert.alert('Could not update permissions', e instanceof Error ? e.message : 'The change was not saved. Please try again.');
      return;
    }
    loadRolePermissionCache();
  }

  function effectiveMinPin(role: UserRole): number {
    return minPins[role] ?? PIN_LENGTH_BY_TIER[ROLE_TIER[role]];
  }

  function changeRoleColor(role: UserRole, color: string | null) {
    if (!canManage) return;
    if (isWriteBlocked()) return;
    try {
      // setRoleColor already mirrors the role_settings UPDATE to the outbox
      // internally — the write + log land atomically so we never log a color
      // the DB didn't actually persist.
      runInTransaction(() => {
        setRoleColor(role, color);
        appendLog({
          action: 'role_color_changed', entity_type: 'role_settings', entity_id: null, user_id: realUser?.id ?? null,
          note: `${role} color → ${color ?? 'default'}`,
          team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: null, metadata: JSON.stringify({ role }), device_id: null,
        });
      });
    } catch (e) {
      Alert.alert('Could not change role color', e instanceof Error ? e.message : 'The color change was not saved. Please try again.');
      return;
    }
    // roleColors memo re-reads via the role_settings table version → preview + swatches update
  }

  async function changeMinPin(role: UserRole, delta: number) {
    if (!canManage) return;
    if (isWriteBlocked()) return;
    const next = Math.min(MAX_PIN, Math.max(MIN_PIN, effectiveMinPin(role) + delta));
    if (next === effectiveMinPin(role)) return;

    const ok = await confirmSheet({
      title: 'Change minimum PIN length?',
      message: impactMessage(role, 'the minimum PIN length'),
      confirmLabel: 'Change',
    });
    if (!ok) return;
    if (isWriteBlocked()) return;

    try {
      runInTransaction(() => {
        setRoleMinPin(role, next);
        appendLog({
          action: 'role_min_pin_changed', entity_type: 'role_settings', entity_id: null, user_id: realUser?.id ?? null,
          note: `${role} → ${next}`,
          team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: null, metadata: JSON.stringify({ role }), device_id: null,
        });
      });
    } catch (e) {
      Alert.alert('Could not change minimum PIN length', e instanceof Error ? e.message : 'The change was not saved. Please try again.');
      return;
    }
  }

  // No impact-preview confirm — unlike the min-PIN/permission edits, this
  // doesn't change what anyone can already do, only how often they're asked
  // to prove it's still them.
  function changeIdleReauth(role: UserRole, minutes: number) {
    if (!canManage) return;
    if (isWriteBlocked()) return;
    try {
      runInTransaction(() => {
        setRoleIdleReauthMinutes(role, minutes);
        appendLog({
          action: 'role_idle_reauth_changed', entity_type: 'role_settings', entity_id: null, user_id: realUser?.id ?? null,
          note: `${role} idle re-auth → ${minutes === 0 ? 'off' : `${minutes} min`}`,
          team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: null, metadata: JSON.stringify({ role }), device_id: null,
        });
      });
    } catch (e) {
      Alert.alert('Could not change idle re-auth', e instanceof Error ? e.message : 'The change was not saved. Please try again.');
      return;
    }
  }

  // "Preview as…" entry point. Picking a role swaps what usePermission/
  // hasPermission/PermissionGate resolve app-wide to that role's view
  // (read-only — the central write-block in db/maintenance.ts covers every
  // write path). Picking the CURRENT real role is equivalent to exiting.
  function pickPreviewRole(role: UserRole) {
    setPreviewPickerOpen(false);
    setPreviewRole(role === realUser?.role ? null : role);
  }
  function exitPreview() {
    setPreviewPickerOpen(false);
    setPreviewRole(null);
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: 'Roles & Permissions',
          headerShown: true,
          // Gated on the EFFECTIVE permission (canManage), same as the rest of
          // this screen — NOT realUser's own permission. Exiting a preview is
          // still always available from the persistent PreviewBanner, which
          // doesn't gate on any permission.
          headerRight: canManage
            ? () => (
                <TouchableOpacity style={s.previewBtn} onPress={() => setPreviewPickerOpen(true)} hitSlop={8}>
                  <Text style={s.previewBtnText}>Preview as…</Text>
                </TouchableOpacity>
              )
            : undefined,
        }}
      />
      <ScrollView style={s.container} contentContainerStyle={s.content}>
        <Text style={s.intro}>
          Each role grants a default set of permissions and a minimum PIN length. Toggle a
          permission to override the default for that role; toggling it back to the default
          removes the override. Per-user exceptions live on each user's profile.
        </Text>

        {locked && <MaintenanceBanner />}

        {ROLES_BY_TIER.map(role => {
          const isOpen = expanded === role;
          const minPin = effectiveMinPin(role);
          // Client-side hierarchy gate (server enforces authoritatively): a
          // manager can't edit the matrix of a role at/above their own
          // effective tier. Fail closed if the session role is missing.
          const callerRole = (user?.role ?? '') as UserRole;
          const canActThisRole = canActOnTarget(callerRole, role);
          return (
            <View key={role} style={s.card}>
              <TouchableOpacity style={s.cardHead} onPress={() => setExpanded(isOpen ? null : role)}>
                <View style={{ flex: 1 }}>
                  <Text style={s.roleName}>{ROLE_DISPLAY_NAMES[role]}</Text>
                  <Text style={s.roleMeta}>{grantedCounts[role]} of {PERMISSION_ORDER.length} permissions</Text>
                </View>
                <Text style={s.tierBadge}>T{ROLE_TIER[role]}</Text>
                <Text style={s.chevron}>{isOpen ? '▾' : '▸'}</Text>
              </TouchableOpacity>

              {canManage && !canActThisRole && (
                <Text style={s.lockNote}>
                  🔒 This role is at or above your access level — you can't change its permissions.
                </Text>
              )}

              {/* Min PIN length stepper */}
              <View style={s.pinRow}>
                <View style={{ flex: 1 }}>
                  <Text style={s.pinLabel}>Minimum PIN length</Text>
                  <Text style={s.pinHint}>Enforced when this role sets their PIN</Text>
                </View>
                <View style={s.stepper}>
                  <TouchableOpacity
                    style={[s.stepBtn, (!canManage || locked || !canActThisRole || minPin <= MIN_PIN) && s.stepBtnOff]}
                    onPress={() => changeMinPin(role, -1)}
                    disabled={!canManage || locked || !canActThisRole || minPin <= MIN_PIN}
                  >
                    <Text style={s.stepText}>−</Text>
                  </TouchableOpacity>
                  <Text style={s.pinValue}>{minPin}</Text>
                  <TouchableOpacity
                    style={[s.stepBtn, (!canManage || locked || !canActThisRole || minPin >= MAX_PIN) && s.stepBtnOff]}
                    onPress={() => changeMinPin(role, +1)}
                    disabled={!canManage || locked || !canActThisRole || minPin >= MAX_PIN}
                  >
                    <Text style={s.stepText}>+</Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Per-role idle re-auth. Independent of the org-wide idle
                  auto-logout (settings, Wave D) — this only re-prompts for the
                  PIN after inactivity; the session itself stays intact. */}
              <View style={s.idleReauthSection}>
                <SelectField
                  label="Idle re-auth"
                  hint="Re-prompt for this role's PIN after this much inactivity, foreground or backgrounded"
                  placeholder="Off"
                  value={String(idleReauthMinutes[role] ?? 0)}
                  options={IDLE_REAUTH_OPTIONS}
                  onSelect={(id) => changeIdleReauth(role, Number(id))}
                  disabled={!canManage || locked || !canActThisRole}
                />
              </View>

              {/* Color swatch picker */}
              {isOpen && (() => {
                const effective = resolveRoleColor(role, roleColors[role]);
                return (
                  <View style={s.colorSection}>
                    <Text style={s.pinLabel}>Name color</Text>
                    <Text style={[s.colorPreview, { color: effective }]}>{ROLE_DISPLAY_NAMES[role]}</Text>
                    <View style={s.colorRow}>
                      {ROLE_COLOR_PALETTE.map(c => (
                        <TouchableOpacity
                          key={c}
                          style={[s.colorCell, { backgroundColor: c }, effective === c && s.colorCellActive, (!canManage || locked || !canActThisRole) && s.colorCellDisabled]}
                          onPress={() => changeRoleColor(role, c)}
                          disabled={!canManage || locked || !canActThisRole}
                        >
                          {effective === c && <Text style={s.colorCheck}>✓</Text>}
                        </TouchableOpacity>
                      ))}
                    </View>
                    {!!roleColors[role] && (
                      <TouchableOpacity
                        onPress={() => changeRoleColor(role, null)}
                        disabled={!canManage || locked || !canActThisRole}
                        style={(!canManage || locked || !canActThisRole) ? s.colorCellDisabled : undefined}
                      >
                        <Text style={s.colorReset}>Reset to default</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })()}

              {/* Editable permission matrix — grouped into collapsible
                  sections: Inventory / Jobs / Scheduling / Financial / Admin,
                  each with its own group-level toggle-all (impact-preview
                  confirm gates every write, single or batched). */}
              {isOpen && (
                <View style={s.matrix}>
                  {PERMISSION_GROUP_NAMES.map(group => {
                    const groupKey = `${role}:${group}`;
                    const groupOpen = expandedGroups.has(groupKey);
                    const perms = PERMISSION_GROUPS[group];
                    const grantedInGroup = perms.filter(p => (isLockedPerm(role, p) ? true : effectivePerm(role, p).value)).length;
                    const editablePerms = perms.filter(p => canEditRolePermission(callerRole, role, p).editable);
                    const allOn = editablePerms.length > 0 && editablePerms.every(p => effectivePerm(role, p).value);
                    const toggleAllDisabled = !canManage || locked || !canActThisRole || editablePerms.length === 0;
                    return (
                      <View key={group} style={s.group}>
                        <View style={s.groupHead}>
                          <TouchableOpacity style={s.groupHeadPress} onPress={() => toggleGroupExpanded(groupKey)}>
                            <Text style={s.chevron}>{groupOpen ? '▾' : '▸'}</Text>
                            <View style={{ flex: 1 }}>
                              <Text style={s.groupName}>{group}</Text>
                              <Text style={s.groupMeta}>{grantedInGroup} of {perms.length}</Text>
                            </View>
                          </TouchableOpacity>
                          <Switch
                            value={allOn}
                            disabled={toggleAllDisabled}
                            onValueChange={() => toggleGroupAll(role, group)}
                            trackColor={{ true: t.colors.primary, false: t.colors.border }}
                          />
                        </View>

                        {groupOpen && (
                          <View style={s.groupBody}>
                            {perms.map(perm => {
                              const lockedPerm = isLockedPerm(role, perm);
                              // Single source of truth for whether this cell may be toggled.
                              const editability = canEditRolePermission(callerRole, role, perm);
                              const { value, modified } = effectivePerm(role, perm);
                              const shown = lockedPerm ? true : value;
                              const disabled = !canManage || locked || !editability.editable;
                              const permReason = canActThisRole && !editability.editable ? editability.reason : null;
                              return (
                                <View key={perm} style={s.permRow}>
                                  <View style={{ flex: 1 }}>
                                    <Text style={[s.permLabel, !shown && s.permLabelOff]}>{PERMISSION_LABELS[perm]}</Text>
                                    {modified && !lockedPerm && <Text style={s.modifiedBadge}>modified</Text>}
                                    {permReason && <Text style={s.lockedBadge}>{permReason}</Text>}
                                  </View>
                                  <Switch
                                    value={shown}
                                    disabled={disabled}
                                    onValueChange={() => togglePerm(role, perm)}
                                    trackColor={{ true: t.colors.primary, false: t.colors.border }}
                                  />
                                </View>
                              );
                            })}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          );
        })}

        {!canManage && (
          <Text style={s.readOnly}>
            👁 You can view roles but not change them. PIN-length controls are disabled.
          </Text>
        )}
      </ScrollView>

      {/* "Preview as…" role picker. Only reachable via the headerRight
          affordance above (canManage-gated); exiting a preview doesn't
          require this sheet — the persistent PreviewBanner's "Exit preview"
          button always works. */}
      <ModalSheet visible={previewPickerOpen} onClose={() => setPreviewPickerOpen(false)}>
        <Text style={s.pickerTitle}>Preview as…</Text>
        <Text style={s.pickerHint}>
          See the app as another role would. Writes stay blocked the whole time — nothing
          done while previewing can change real data.
        </Text>
        {previewRole != null && (
          <TouchableOpacity style={s.pickerExitRow} onPress={exitPreview}>
            <Text style={s.pickerExitText}>✕ Exit preview</Text>
          </TouchableOpacity>
        )}
        {ROLES_BY_TIER.map(role => {
          const active = (previewRole ?? realUser?.role) === role;
          return (
            <TouchableOpacity key={role} style={s.pickerRow} onPress={() => pickPreviewRole(role)}>
              <Text style={[s.pickerRoleName, active && s.pickerRoleNameActive]}>{ROLE_DISPLAY_NAMES[role]}</Text>
              {active && <Text style={s.pickerCheck}>✓</Text>}
            </TouchableOpacity>
          );
        })}
      </ModalSheet>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.lg, gap: 10, paddingBottom: 48 },
  intro: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, lineHeight: 19, marginBottom: 2 },

  card: { backgroundColor: t.colors.surface, borderRadius: t.radii.lg, borderWidth: 1, borderColor: t.colors.border, overflow: 'hidden' },
  cardHead: { flexDirection: 'row', alignItems: 'center', padding: t.spacing.base, gap: 10 },
  roleName: { fontSize: t.typography.fontSizes.base, fontWeight: '600', color: t.colors.textPrimary },
  roleMeta: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 2 },
  tierBadge: { fontSize: t.typography.fontSizes.sm, fontWeight: '700', color: t.colors.primary, backgroundColor: t.colors.primaryBgStrong, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  chevron: { fontSize: t.typography.fontSizes.base, color: t.colors.textMuted },

  pinRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: t.spacing.base, paddingBottom: t.spacing.base, gap: 10 },
  pinLabel: { fontSize: t.typography.fontSizes.body2, color: t.colors.textPrimary, fontWeight: '500' },
  pinHint: { fontSize: t.typography.fontSizes.sm, color: t.colors.textMuted, marginTop: 1 },
  stepper: { flexDirection: 'row', alignItems: 'center', backgroundColor: t.colors.surfaceAlt, borderRadius: t.radii.md },
  stepBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  stepBtnOff: { opacity: 0.3 },
  stepText: { fontSize: 22, color: t.colors.primaryText, fontWeight: '600' },
  pinValue: { fontSize: t.typography.fontSizes.base, fontWeight: '700', color: t.colors.textPrimary, minWidth: 24, textAlign: 'center' },

  matrix: { borderTopWidth: 1, borderTopColor: t.colors.surfaceAlt, paddingHorizontal: t.spacing.base, paddingVertical: 8 },

  group: { borderTopWidth: 1, borderTopColor: t.colors.surfaceAlt, paddingVertical: 4 },
  groupHead: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10 },
  groupHeadPress: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  groupName: { fontSize: t.typography.fontSizes.body2, fontWeight: '700', color: t.colors.textPrimary },
  groupMeta: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 1 },
  groupBody: { paddingLeft: 18, paddingBottom: 4 },

  permRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10 },
  permLabel: { fontSize: t.typography.fontSizes.body2, color: t.colors.textPrimary },
  permLabelOff: { color: t.colors.textMuted },
  modifiedBadge: { fontSize: t.typography.fontSizes.caption, color: t.colors.warning, fontWeight: '600', marginTop: 2 },
  lockedBadge: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 2 },

  readOnly: { fontSize: t.typography.fontSizes.body2, color: t.colors.textMuted, textAlign: 'center', marginTop: 8, lineHeight: 19 },
  lockNote: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, lineHeight: 17, paddingHorizontal: t.spacing.base, paddingBottom: t.spacing.base },

  idleReauthSection: { paddingHorizontal: t.spacing.base, paddingBottom: t.spacing.sm },
  colorSection: { paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.sm, gap: t.spacing.sm },
  colorPreview: { fontSize: t.typography.fontSizes.base, fontWeight: '700' },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  colorCell: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  colorCellActive: { borderWidth: 3, borderColor: t.colors.textPrimary },
  colorCellDisabled: { opacity: 0.4 },
  colorCheck: { color: '#fff', fontSize: t.typography.fontSizes.body, fontWeight: '800' },
  colorReset: { fontSize: t.typography.fontSizes.caption, color: t.colors.primaryText, fontWeight: '600' },

  previewBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    marginRight: 4,
  },
  previewBtnText: { color: t.colors.headerTint, fontSize: 13, fontWeight: t.typography.weights.semibold },

  pickerTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary },
  pickerHint: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, marginTop: t.spacing.sm, lineHeight: 19, marginBottom: t.spacing.sm },
  pickerExitRow: {
    paddingVertical: 12, paddingHorizontal: t.spacing.base, borderRadius: t.radii.md,
    backgroundColor: t.colors.surfaceAlt, marginBottom: t.spacing.sm,
  },
  pickerExitText: { fontSize: t.typography.fontSizes.body2, color: t.colors.warning, fontWeight: '700', textAlign: 'center' },
  pickerRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, borderTopWidth: 1, borderTopColor: t.colors.surfaceAlt,
  },
  pickerRoleName: { fontSize: t.typography.fontSizes.base, color: t.colors.textPrimary },
  pickerRoleNameActive: { fontWeight: '700', color: t.colors.primaryText },
  pickerCheck: { fontSize: t.typography.fontSizes.base, fontWeight: '700', color: t.colors.primaryText },
});
