import { useState, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Switch, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import {
  ROLE_DISPLAY_NAMES, ROLE_TIER, ROLE_DEFAULTS, PIN_LENGTH_BY_TIER,
  UserRole, Permission, ROLE_COLOR_PALETTE, resolveRoleColor, canActOnTarget,
} from '../../../src/constants/roles';
import {
  getRoleSettings, setRoleMinPin,
  getRolePermissionOverrides, setRolePermission,
  getRoleColorMap, setRoleColor,
} from '../../../src/db/queries/users';
import { loadRolePermissionCache, canEditRolePermission } from '../../../src/auth/permissions';
import {
  getDashboardPresets, getRoleDashboardPresetIds, setRoleDashboardPreset,
} from '../../../src/db/queries/dashboards';
import { loadDashboardCache } from '../../../src/dashboard/store';
import { dashboardPresetOptions } from '../../../src/dashboard/presetOptions';
import { SelectField } from '../../../src/components/ui/SelectField';
import { appendOutbox } from '../../../src/sync/outbox';
import { runInTransaction } from '../../../src/db/tx';
import { Alert } from '../../../src/lib/themedAlert';
import { usePermission } from '../../../src/hooks/usePermission';
import { useTableVersion } from '../../../src/hooks/useDataVersion';
import { appendLog } from '../../../src/db/queries/log';
import { useSession } from '../../../src/hooks/useSession';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import type { Theme } from '../../../src/themes/types';
import { useTheme } from '../../../src/hooks/useTheme';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

const ALL_ROLES = Object.keys(ROLE_DISPLAY_NAMES) as UserRole[];

// Order roles by tier (highest authority first) so the list reads top-down.
const ROLES_BY_TIER = [...ALL_ROLES].sort((a, b) => ROLE_TIER[b] - ROLE_TIER[a] || a.localeCompare(b));

const PERMISSION_LABELS: Record<Permission, string> = {
  checkout_inventory: 'Check out inventory',
  checkin_inventory: 'Check in inventory',
  add_inventory: 'Add catalog items',
  quick_add: 'Quick add (items / stock / equipment)',
  edit_inventory: 'Edit catalog items',
  delete_inventory: 'Delete catalog items',
  transfer_between_locations: 'Transfer between locations',
  create_jobs: 'Create jobs',
  close_jobs: 'Close jobs',
  manage_locations: 'Manage locations',
  upload_media: 'Upload photos/video',
  edit_media: 'Edit media details (caption/location, move)',
  delete_media: 'Delete photos/video',
  view_all_logs: 'View all activity logs',
  view_own_logs: 'View own activity logs',
  view_team_activity: "View team's activity",
  manage_teams: 'Manage teams',
  checkout_for_team: 'Check out for a team',
  manage_users: 'Manage users',
  set_pins: 'Set / reset PINs',
  manage_roles_permissions: 'Manage roles & permissions',
  view_financial_data: 'View financial data',
  system_settings: 'Change system settings',
  send_notifications: 'Send broadcast notifications',
  view_audit_log: 'View the API audit log',
};

const PERMISSION_ORDER = Object.keys(PERMISSION_LABELS) as Permission[];

const MIN_PIN = 4;
const MAX_PIN = 8;

// Self-lockout guard: full_admin must always retain the keys to the kingdom, so
// these two are forced ON and non-toggleable for that role in the matrix.
const FULL_ADMIN_LOCKED: Permission[] = ['manage_roles_permissions', 'system_settings'];
function isLockedPerm(role: UserRole, perm: Permission): boolean {
  return role === 'full_admin' && FULL_ADMIN_LOCKED.includes(perm);
}

export default function RolesScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { user: sessionUser } = useSession();
  const { locked } = useMaintenanceMode();
  const canManage = usePermission('manage_roles_permissions');
  // Re-read when a local write or sync pull touches the tables this screen
  // renders — replaces the old manual post-write setState re-reads.
  const version = useTableVersion(['role_settings', 'dashboard_presets']);
  const minPins = useMemo<Record<string, number>>(() => getRoleSettings(), [version]);
  // Per-role permission deviations from ROLE_DEFAULTS ({role: {perm: bool}}).
  const overrides = useMemo<Record<string, Record<string, boolean>>>(
    () => getRolePermissionOverrides(),
    [version],
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const roleColors = useMemo<Record<string, string>>(() => getRoleColorMap(), [version]);
  const rolePresets = useMemo<Record<string, string | null>>(() => getRoleDashboardPresetIds(), [version]);
  const presets = useMemo(() => getDashboardPresets(), [version]);

  // Effective value of a role→permission cell: ROLE_DEFAULTS merged with the
  // role override (when a key exists). `modified` flags an active override.
  function effectivePerm(role: UserRole, perm: Permission): { value: boolean; modified: boolean } {
    const def = ROLE_DEFAULTS[role][perm];
    const ov = overrides[role];
    const modified = !!ov && perm in ov;
    return { value: modified ? ov[perm] : def, modified };
  }

  // Counts reflect the EFFECTIVE grants (defaults + overrides), incl. the
  // forced-ON self-lockout perms for full_admin.
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

  function togglePerm(role: UserRole, perm: Permission) {
    if (!canManage) return;
    if (isLockedPerm(role, perm)) return; // self-lockout guard
    // Only a full_admin may grant/revoke the destructive delete permissions
    // (mirrored + enforced server-side on the role_settings sync write).
    if ((perm === 'delete_inventory' || perm === 'delete_media') && sessionUser?.role !== 'full_admin') return;
    if (isWriteBlocked()) return;
    const def = ROLE_DEFAULTS[role][perm];
    const { value: cur } = effectivePerm(role, perm);
    const next = !cur;
    try {
      // The override write + its activity log land together so a mid-flow failure
      // can't leave the override saved without a log entry (or vice-versa).
      runInTransaction(() => {
        // Toggling back to the default removes the override key (clean reset).
        // setRolePermission already mirrors the permission_overrides UPDATE to the
        // sync outbox internally (see queries/users.ts), so the change syncs — we do
        // NOT append another outbox row here or it would double-sync the same row.
        setRolePermission(role, perm, next === def ? null : next);
        appendLog({
          action: 'role_permission_changed',
          entity_type: 'role_settings',
          // A role is identified by a string key (e.g. "hr_manager"), not a UUID, so it
          // cannot go in the UUID `entity_id` column — the server rejects it ("invalid
          // input syntax for type uuid"). Keep entity_id null; carry the role in the
          // note + metadata. The permission change itself syncs via role_settings UPDATE.
          entity_id: null,
          user_id: sessionUser?.id ?? null,
          note: `${role} · ${perm}: ${next === def ? 'reset to default' : next}`,
          team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: null, metadata: JSON.stringify({ role }), device_id: null,
        });
      });
    } catch (e) {
      Alert.alert(
        'Could not update permission',
        e instanceof Error ? e.message : 'The change was not saved. Please try again.'
      );
      return;
    }
    // Commit succeeded — refresh the permission cache so gates elsewhere see the
    // change; the overrides memo re-reads via the role_settings table version.
    loadRolePermissionCache();
  }

  function effectiveMinPin(role: UserRole): number {
    return minPins[role] ?? PIN_LENGTH_BY_TIER[ROLE_TIER[role]];
  }

  function changeRoleColor(role: UserRole, color: string | null) {
    if (!canManage) return;
    if (isWriteBlocked()) return;
    try {
      // Write + outbox + log land atomically so we never sync/log a color the DB
      // didn't actually persist.
      runInTransaction(() => {
        const now = setRoleColor(role, color);
        appendOutbox('UPDATE', 'role_settings', { role, color, updated_at: now });
        appendLog({
          action: 'role_color_changed',
          entity_type: 'role_settings',
          entity_id: null,
          user_id: sessionUser?.id ?? null,
          note: `${role} color → ${color ?? 'default'}`,
          team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: null, metadata: JSON.stringify({ role }), device_id: null,
        });
      });
    } catch (e) {
      Alert.alert(
        'Could not change role color',
        e instanceof Error ? e.message : 'The color change was not saved. Please try again.'
      );
      return;
    }
    // roleColors memo re-reads via the role_settings table version → preview + swatches update
  }

  function changeRolePreset(role: UserRole, presetId: string | null) {
    if (!canManage) return;
    if (isWriteBlocked()) return;
    const presetName = presetId ? (presets.find(x => x.id === presetId)?.name ?? presetId) : 'default';
    try {
      // Write + log land atomically. setRoleDashboardPreset already mirrors the
      // role_settings UPDATE to the sync outbox internally (see queries/dashboards.ts)
      // — do NOT appendOutbox here or the row double-syncs.
      runInTransaction(() => {
        setRoleDashboardPreset(role, presetId);
        appendLog({
          action: 'role_dashboard_preset_changed',
          entity_type: 'role_settings',
          // Role keys aren't UUIDs — entity_id must stay null (see role_permission_changed above).
          entity_id: null,
          user_id: sessionUser?.id ?? null,
          note: `${role} dashboard → ${presetName}`,
          team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: null, metadata: JSON.stringify({ role }), device_id: null,
        });
      });
    } catch (e) {
      Alert.alert(
        'Could not change dashboard preset',
        e instanceof Error ? e.message : 'The change was not saved. Please try again.'
      );
      return;
    }
    // rolePresets memo re-reads via the role_settings table version
    loadDashboardCache(); // notify subscribers → affected dashboards re-render live (no remount)
  }

  function changeMinPin(role: UserRole, delta: number) {
    if (!canManage) return;
    if (isWriteBlocked()) return;
    const next = Math.min(MAX_PIN, Math.max(MIN_PIN, effectiveMinPin(role) + delta));
    if (next === effectiveMinPin(role)) return;
    try {
      // Write + outbox + log land atomically so a partial failure can't sync/log a
      // PIN length the DB didn't persist.
      runInTransaction(() => {
        const now = setRoleMinPin(role, next);
        appendOutbox('UPDATE', 'role_settings', { role, min_pin_length: next, updated_at: now });
        appendLog({
          action: 'role_min_pin_changed',
          entity_type: 'role_settings',
          // Role keys aren't UUIDs — keep entity_id null (see role_permission_changed above).
          entity_id: null,
          user_id: sessionUser?.id ?? null,
          note: `${role} → ${next}`,
          team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: null, metadata: JSON.stringify({ role }), device_id: null,
        });
      });
    } catch (e) {
      Alert.alert(
        'Could not change minimum PIN length',
        e instanceof Error ? e.message : 'The change was not saved. Please try again.'
      );
      return;
    }
    // minPins memo re-reads via the role_settings table version after commit
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Roles & Permissions', headerShown: true }} />
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
          // Client-side hierarchy gate (server enforces authoritatively): a manager
          // can't edit the matrix of a role at/above their own effective tier — e.g.
          // a tier-3 with manage_roles_permissions can't touch a tier-4 role. Fail
          // closed if the session role is missing.
          const callerRole = (sessionUser?.role ?? '') as UserRole;
          const canActThisRole = canActOnTarget(callerRole, role);
          return (
            <View key={role} style={s.card}>
              <TouchableOpacity style={s.cardHead} onPress={() => setExpanded(isOpen ? null : role)}>
                <View style={{ flex: 1 }}>
                  <Text style={s.roleName}>{ROLE_DISPLAY_NAMES[role]}</Text>
                  <Text style={s.roleMeta}>
                    {grantedCounts[role]} of {PERMISSION_ORDER.length} permissions
                  </Text>
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
                        style={(!canManage || locked || !canActThisRole) && s.colorCellDisabled}
                      >
                        <Text style={s.colorReset}>Reset to default</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                );
              })()}

              {/* Per-role dashboard preset (users.dashboard_preset_id overrides win; NULL → built-in default) */}
              {isOpen && (
                <View style={s.presetSection}>
                  <SelectField
                    label="Dashboard preset"
                    hint="The dashboard this role sees. Per-user assignments override it."
                    placeholder="Default"
                    value={rolePresets[role] ?? null}
                    options={dashboardPresetOptions(presets, rolePresets[role] ?? null)}
                    onSelect={(id) => changeRolePreset(role, id)}
                    onClear={rolePresets[role] ? () => changeRolePreset(role, null) : undefined}
                    disabled={!canManage || locked || !canActThisRole}
                  />
                </View>
              )}

              {/* Editable permission matrix */}
              {isOpen && (
                <View style={s.matrix}>
                  {PERMISSION_ORDER.map(perm => {
                    const lockedPerm = isLockedPerm(role, perm);
                    // Single source of truth for whether this cell may be toggled —
                    // the shared canEditRolePermission mirrors the server's role_settings
                    // rules (tier guard + full_admin floor + full_admin-only delete grant)
                    // so the editor can't drift from what the server accepts (#82).
                    const editability = canEditRolePermission(callerRole, role, perm);
                    const { value, modified } = effectivePerm(role, perm);
                    const shown = lockedPerm ? true : value;
                    const disabled = !canManage || locked || !editability.editable;
                    // The tier-guard reason is shown once at the role level above; here
                    // surface only the per-permission reasons (floor / delete-grant) when
                    // the caller can otherwise act on this role.
                    const permReason = canActThisRole && !editability.editable ? editability.reason : null;
                    return (
                      <View key={perm} style={s.permRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={[s.permLabel, !shown && s.permLabelOff]}>
                            {PERMISSION_LABELS[perm]}
                          </Text>
                          {modified && !lockedPerm && (
                            <Text style={s.modifiedBadge}>modified</Text>
                          )}
                          {permReason && (
                            <Text style={s.lockedBadge}>{permReason}</Text>
                          )}
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

        {!canManage && (
          <Text style={s.readOnly}>
            👁 You can view roles but not change them. PIN-length controls are disabled.
          </Text>
        )}
      </ScrollView>
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
  permRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10 },
  permCheck: { width: 18, textAlign: 'center', fontSize: t.typography.fontSizes.body, fontWeight: '700' },
  permYes: { color: t.colors.success },
  permNo: { color: t.colors.textDisabled },
  permLabel: { fontSize: t.typography.fontSizes.body2, color: t.colors.textPrimary },
  permLabelOff: { color: t.colors.textMuted },
  modifiedBadge: { fontSize: t.typography.fontSizes.caption, color: t.colors.warning, fontWeight: '600', marginTop: 2 },
  lockedBadge: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: 2 },

  readOnly: { fontSize: t.typography.fontSizes.body2, color: t.colors.textMuted, textAlign: 'center', marginTop: 8, lineHeight: 19 },
  lockNote: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, lineHeight: 17, paddingHorizontal: t.spacing.base, paddingBottom: t.spacing.base },

  colorSection: { paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.sm, gap: t.spacing.sm },
  colorPreview: { fontSize: t.typography.fontSizes.base, fontWeight: '700' },
  colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  colorCell: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  colorCellActive: { borderWidth: 3, borderColor: t.colors.textPrimary },
  colorCellDisabled: { opacity: 0.4 },
  colorCheck: { color: '#fff', fontSize: t.typography.fontSizes.body, fontWeight: '800' },
  colorReset: { fontSize: t.typography.fontSizes.caption, color: t.colors.primaryText, fontWeight: '600' },

  presetSection: { paddingHorizontal: t.spacing.base, paddingBottom: t.spacing.sm },
});
