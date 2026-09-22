// Ported from apps/mobile/src/components/crew/MemberPermissionsSheet.tsx.
// Import mapping applied (docs/REBUILD-PORTING.md):
//   '../../db/queries/teams' → '../../repos/teams' (setMemberPermissionOverridesOnline,
//     TEAM_OVERRIDABLE_PERMISSIONS, TEAM_PERMISSION_LABELS, TeamMember)
//   '../../db/queries/log' (appendLog) → '../../db/queries/log' (unchanged path)
//   '../../db/queries/access' + '../../db/queries/unitAccess' + '../../access/unitGrants'
//     → '../../repos/access' (Station B3 merged all three into one repo file)
//   '../../access/personalLocker' → '../../access/personalLocker' (unchanged path)
//   '../../auth/permissions', '../../constants/roles' → unchanged (already at these
//     paths in mobile-v2)
//   ui/* + useTheme/useThemedStyles/useSession/usePermission/useMaintenanceMode/
//     isWriteBlocked/confirmSheet → '@invenpro/ui' / '../../hooks/*' / '../../db/maintenance'
//   '../SearchablePicker' → '../SearchablePicker' (unchanged path)
//   '../../hooks/useDataVersion' (useTableVersion) → '@invenpro/core'
//
// Station B3: the two sections stubbed out in B2 (per-unit access grants +
// personal locker toggle) are restored below now that repos/access.ts +
// access/personalLocker.ts exist. Self-log DIVERGENCE: repos/access.ts's
// upsertUnitAccess/revokeUnitAccess do NOT self-log (unlike the old app's
// db/queries/unitAccess.ts) — every write below wraps
// `runInTransaction(() => { repoFn(...); appendLog({...}); })` itself, using
// the exact old action names ('unit_access_granted'/'unit_access_revoked')
// and metadata shapes (see repos/access.ts's own doc comments on each write).
import { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import type { Theme } from '@invenpro/ui';
import {
  Alert, useTheme, useThemedStyles, ModalSheet, PrimaryButton, MaintenanceBanner, confirmSheet,
} from '@invenpro/ui';
import { runInTransaction, useTableVersion } from '@invenpro/core';
import { useSession } from '../../hooks/useSession';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { usePermission } from '../../hooks/usePermission';
import { isWriteBlocked } from '../../db/maintenance';
import {
  setMemberPermissionOverridesOnline, TEAM_OVERRIDABLE_PERMISSIONS, TEAM_PERMISSION_LABELS,
  type TeamMember,
} from '../../repos/teams';
import { parsePermissionOverrides, roleHasPermission } from '../../auth/permissions';
import { canActOnTarget } from '../../constants/roles';
import type { Permission, UserRole } from '../../constants/roles';
import {
  getUserUnitGrants, getGrantableUnits, getManagedOwnerIds, upsertUnitAccess, revokeUnitAccess,
  grantUnitAccessWithDefaults, type UserUnitGrant,
} from '../../repos/access';
import { getDefaultActionsForRole } from '../../db/unitAccessDefaults';
import { enablePersonalLocker, disablePersonalLocker, getPersonalLocker } from '../../access/personalLocker';
import { canManageUnitAccess } from '../../access/unitAccessPolicy';
import { appendLog } from '../../db/queries/log';
import { SearchablePicker, type PickerOption } from '../SearchablePicker';

// Combined Member Permissions sheet (#122 Phase B) — one sheet per team member:
// their team permission overrides (moved verbatim from teams/[id].tsx's
// inline ModalSheet) PLUS their per-unit unit_access grants (per-action
// switches, revoke, grant-new-unit with the admin's per-role defaults
// auto-applied via grantUnitAccessWithDefaults). Editability of each grant is
// courtesy-gated by the canManageUnitAccess mobile mirror; /sync/push is the
// enforcement of record.

const UNIT_ACTIONS = [
  ['can_view', 'See contents'], ['can_add', 'Add stock'], ['can_remove', 'Take stock'],
  ['can_move', 'Move stock'], ['can_edit_details', 'Edit details'], ['can_grant', 'Grant access'],
] as const;

export function MemberPermissionsSheet(props: {
  visible: boolean;
  onClose: () => void;
  teamId: string;
  teamName: string;
  member: TeamMember | null;
  /** bump the host screen's local version after any write */
  onChanged: () => void;
}) {
  const { visible, onClose, teamId, teamName, member, onChanged } = props;
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();

  // ── Team permission overrides ───────────────────────────────────────────

  const [permDraft, setPermDraft] = useState<Record<string, boolean>>({});
  const [savingPerms, setSavingPerms] = useState(false);
  // Re-read grants/locker when a sync pull (or our own local write) touches
  // the access tables.
  const version = useTableVersion(['unit_access', 'team_members', 'users', 'locations']);
  const [addUnitOpen, setAddUnitOpen] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState<PickerOption | null>(null);

  // Seed the draft (and reset the unit-grant picker) whenever the target member
  // changes; unsaved toggles are discarded on dismiss (draft-only until Save).
  useEffect(() => {
    setPermDraft(member ? parsePermissionOverrides(member.team_permission_overrides) : {});
    setAddUnitOpen(false);
    setSelectedUnit(null);
  }, [member]);

  function togglePermDraft(perm: Permission) {
    if (!member) return;
    // Baseline = the ROLE's effective permission (default + role override) —
    // roleHasPermission is reactive via the role-override cache.
    const base = roleHasPermission((member.user_role ?? '') as UserRole, perm);
    const cur = perm in permDraft ? permDraft[perm] : base;
    const next = !cur;
    setPermDraft(prev => {
      const copy = { ...prev };
      if (next === base) delete copy[perm]; else copy[perm] = next;
      return copy;
    });
  }

  async function handleSavePermDraft() {
    if (!member) return;
    if (isWriteBlocked()) return;
    setSavingPerms(true);
    try {
      await setMemberPermissionOverridesOnline(teamId, member.user_id, permDraft);
    } catch (e) {
      setSavingPerms(false);
      Alert.alert('Could not update permissions', (e as Error).message);
      return;
    }
    // Activity log is best-effort (and never blocks the change already committed above).
    try {
      appendLog({
        user_id: realUser?.id ?? null,
        team_id: teamId,
        action: 'user_permission_changed',
        entity_type: 'user',
        entity_id: member.user_id,
        from_location_id: null,
        to_location_id: null,
        quantity: null,
        unit: null,
        job_id: null,
        note: `${member.user_name ?? member.user_id} · ${teamName} team permissions updated`,
        metadata: JSON.stringify({ team_id: teamId, overrides: permDraft }),
        device_id: null,
      });
    } catch { /* logging is non-critical */ }
    setSavingPerms(false);
    onChanged();
    onClose();
  }

  // ── Per-unit access grants (#122 Phase B) ──────────────────────────────────

  const grants = useMemo(
    () => (member ? getUserUnitGrants(member.user_id) : []),
    [member?.user_id, version],
  );
  const managedOwners = useMemo(
    () => (user ? getManagedOwnerIds(user.id) : new Set<string>()),
    [user?.id, version],
  );

  function canEditGrant(g: UserUnitGrant): boolean {
    return !!user && canManageUnitAccess({
      callerId: user.id, callerRole: user.role, ownerUserId: g.owner_user_id,
      callerManagesOwnersTeam: g.owner_user_id != null && managedOwners.has(g.owner_user_id),
      granteeRole: member?.user_role ?? null,
    });
  }

  // Per-action EDITS go through upsertUnitAccess directly (only grant CREATION
  // applies the defaults template). No-self-log repo — this screen owns the
  // appendLog call (see the header comment).
  function toggleUnitAction(g: UserUnitGrant, col: typeof UNIT_ACTIONS[number][0]) {
    if (isWriteBlocked()) return;
    const { location_name, location_type, owner_user_id, ...row } = g;
    const b = (v: number): boolean => !!v;
    const now = new Date().toISOString();
    const nextFlags = {
      can_view: b(row.can_view), can_add: b(row.can_add), can_remove: b(row.can_remove),
      can_move: b(row.can_move), can_edit_details: b(row.can_edit_details), can_grant: b(row.can_grant),
      [col]: !g[col],
    };
    runInTransaction(() => {
      upsertUnitAccess({ ...row, ...nextFlags, updated_at: now });
      appendLog({
        action: 'unit_access_granted', entity_type: 'location', entity_id: row.location_id,
        user_id: row.granted_by, team_id: null, job_id: null,
        note: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
        metadata: JSON.stringify({
          grantee_user_id: row.user_id,
          actions: {
            view: nextFlags.can_view, add: nextFlags.can_add, remove: nextFlags.can_remove,
            move: nextFlags.can_move, edit_details: nextFlags.can_edit_details, grant: nextFlags.can_grant,
          },
        }),
        device_id: null,
      });
    });
    onChanged();
  }

  async function handleRevoke(g: UserUnitGrant) {
    const ok = await confirmSheet({
      title: 'Revoke', message: `Remove ${member?.user_name ?? 'this member'}'s access to ${g.location_name}?`,
      confirmLabel: 'Revoke', destructive: true,
    });
    if (!ok || isWriteBlocked()) return;
    runInTransaction(() => {
      revokeUnitAccess(g.location_id, g.user_id);
      appendLog({
        action: 'unit_access_revoked', entity_type: 'location', entity_id: g.location_id,
        user_id: null, team_id: null, job_id: null,
        note: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
        metadata: JSON.stringify({ grantee_user_id: g.user_id }), device_id: null,
      });
    });
    onChanged();
  }

  function handleGrantUnit() {
    if (!member || !selectedUnit || isWriteBlocked()) return;
    const actorId = realUser?.id ?? null;
    const granteeRole = member.user_role ?? '';
    const unitId = selectedUnit.id;
    const granteeUserId = member.user_id;
    runInTransaction(() => {
      grantUnitAccessWithDefaults(unitId, granteeUserId, granteeRole, actorId);
      const actions = getDefaultActionsForRole(granteeRole);
      appendLog({
        action: 'unit_access_granted', entity_type: 'location', entity_id: unitId,
        user_id: actorId, team_id: null, job_id: null,
        note: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
        metadata: JSON.stringify({
          grantee_user_id: granteeUserId,
          actions: {
            view: actions.view, add: actions.add, remove: actions.remove,
            move: actions.move, edit_details: actions.editDetails, grant: actions.grant,
          },
        }),
        device_id: null,
      });
    });
    setSelectedUnit(null); setAddUnitOpen(false);
    onChanged();
  }

  // Personal locker (#146) — provisioning is a locations write, so the toggle
  // only renders when the CURRENT session carries manage_locations (otherwise
  // the outbox UPDATE would be rejected server-side by syncPolicy). `version`
  // already tracks the locations table, so the state re-reads after each flip.
  // Neither enablePersonalLocker/disablePersonalLocker nor this caller logs —
  // matches the old app exactly (no self-log divergence here).
  const canManageLocations = usePermission('manage_locations');
  const personalLocker = useMemo(
    () => (member ? getPersonalLocker(member.user_id) : null),
    [member?.user_id, version],
  );

  function togglePersonalLocker() {
    if (!member || isWriteBlocked()) return;
    if (personalLocker) {
      const res = disablePersonalLocker(member.user_id);
      if (!res.ok) { Alert.alert('Could not turn off locker', res.reason); return; }
    } else {
      const res = enablePersonalLocker(
        member.user_id, member.user_name ?? '', member.user_role ?? '', realUser?.id ?? null,
      );
      if (!res.ok) { Alert.alert('Could not create locker', res.reason); return; }
    }
    onChanged();
  }

  // Units the caller may grant on for this member, minus units already granted.
  const grantableOptions = useMemo<PickerOption[]>(() => {
    if (!user || !member) return [];
    const already = new Set(grants.map(g => g.location_id));
    return getGrantableUnits(user, member.user_role ?? null)
      .filter(l => !already.has(l.id))
      .map(l => ({ id: l.id, label: l.name, sublabel: l.type ?? undefined }));
  }, [user?.id, member?.user_id, member?.user_role, grants, version]);

  // Mirror the host row's hierarchy gate inside the editor as a safety net
  // (the Perms button is already disabled for out-of-tier members).
  const permMemberLocked = !canActOnTarget((user?.role ?? '') as UserRole, (member?.user_role ?? '') as UserRole);

  return (
    <ModalSheet visible={visible} onClose={onClose} scroll={false}>
      <Text style={s.title}>
        {member ? `${member.user_name ?? member.user_id} · Permissions` : 'Permissions'}
      </Text>
      {/* flexShrink:1 lets this ScrollView shrink within ModalSheet's maxHeight cap so it actually scrolls (RN defaults flexShrink:0). */}
      <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 4 }}>
        <Text style={s.permsIntro}>
          Overrides apply only within {teamName}. Toggling a permission back to its
          default removes the override.
        </Text>
        {member && TEAM_OVERRIDABLE_PERMISSIONS.map(perm => {
          const base = roleHasPermission((member.user_role ?? '') as UserRole, perm);
          const value = perm in permDraft ? permDraft[perm] : base;
          const modified = perm in permDraft;
          return (
            <View key={perm} style={s.permRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.permLabel}>{TEAM_PERMISSION_LABELS[perm]}</Text>
                {modified && <Text style={s.modifiedBadge}>overridden</Text>}
              </View>
              <Switch
                value={value}
                disabled={locked || savingPerms || permMemberLocked}
                onValueChange={() => togglePermDraft(perm)}
                trackColor={{ true: t.colors.primary, false: t.colors.border }}
              />
            </View>
          );
        })}

        <PrimaryButton
          label={savingPerms ? 'Saving…' : 'Save Permissions'}
          onPress={handleSavePermDraft}
          disabled={locked || savingPerms}
          style={{ marginTop: 8 }}
        />

        {/* Per-unit access grants — writes land immediately (no draft). Locker
            units only this wave — see repos/access.ts's header PORT NOTE. */}
        <View style={s.sectionDivider} />
        <Text style={s.sectionLabel}>Unit access</Text>
        {grants.length === 0 && (
          <Text style={s.muted}>No unit access grants yet.</Text>
        )}
        {grants.map(g => {
          const editable = canEditGrant(g);
          return (
            <View key={g.location_id} style={s.grantCard}>
              <View style={s.grantHeader}>
                <Text style={s.grantName} numberOfLines={1}>
                  🔒 {g.location_name}
                </Text>
                {editable && (
                  <TouchableOpacity
                    onPress={() => handleRevoke(g)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    style={s.removeBtn}
                  >
                    <Text style={s.removeText}>Revoke</Text>
                  </TouchableOpacity>
                )}
              </View>
              {UNIT_ACTIONS.map(([col, label]) => (
                <View key={col} style={s.permRow}>
                  <Text style={[s.permLabel, { flex: 1 }]}>{label}</Text>
                  <Switch
                    value={!!g[col]}
                    disabled={locked || !editable}
                    onValueChange={() => toggleUnitAction(g, col)}
                    trackColor={{ true: t.colors.primary, false: t.colors.border }}
                  />
                </View>
              ))}
            </View>
          );
        })}

        {grantableOptions.length > 0 && !addUnitOpen && (
          <TouchableOpacity
            onPress={() => setAddUnitOpen(true)}
            disabled={locked}
            style={locked ? s.disabled : undefined}
          >
            <Text style={s.addLink}>+ Grant access to a unit</Text>
          </TouchableOpacity>
        )}
        {addUnitOpen && (
          <>
            <SearchablePicker
              placeholder="Search units…"
              options={grantableOptions}
              value={selectedUnit}
              onSelect={(opt) => setSelectedUnit(prev => (prev?.id === opt.id ? null : opt))}
            />
            <PrimaryButton
              label="Grant"
              onPress={handleGrantUnit}
              disabled={!selectedUnit || locked}
            />
          </>
        )}

        {/* Personal locker (#146) — manage_locations only (see comment above). */}
        {canManageLocations && member && (
          <>
            <View style={s.sectionDivider} />
            <Text style={s.sectionLabel}>Personal locker</Text>
            <View style={s.permRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.permLabel}>Personal locker</Text>
                <Text style={s.lockerHint}>
                  {personalLocker
                    ? `${personalLocker.name} — turning off retires it (stock must be moved out first).`
                    : "Creates a locker owned by this member with their role's unit-access defaults."}
                </Text>
              </View>
              <Switch
                value={!!personalLocker}
                disabled={locked}
                onValueChange={togglePersonalLocker}
                trackColor={{ true: t.colors.primary, false: t.colors.border }}
                accessibilityLabel={`Personal locker, ${personalLocker ? 'on' : 'off'}`}
              />
            </View>
          </>
        )}

        {locked && <MaintenanceBanner />}
        <TouchableOpacity style={s.cancelRow} onPress={onClose}>
          <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  title: { fontSize: 18, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 14 },
  muted: { fontSize: 14, color: t.colors.textMuted },

  permsIntro: { fontSize: 13, color: t.colors.textSecondary, lineHeight: 18, marginBottom: 8 },
  permRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10 },
  permLabel: { fontSize: 14, color: t.colors.textPrimary },
  lockerHint: { fontSize: 12, color: t.colors.textSecondary, marginTop: 2, lineHeight: 16 },
  modifiedBadge: { fontSize: 11, color: t.colors.warning, fontWeight: '600', marginTop: 2 },

  sectionDivider: { borderTopWidth: 1, borderTopColor: t.colors.surfaceAlt, marginTop: 12 },
  sectionLabel: {
    fontSize: t.typography.fontSizes.xs, fontWeight: t.typography.weights.bold,
    color: t.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5,
    marginTop: t.spacing.sm,
  },

  grantCard: {
    borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radii.md,
    paddingHorizontal: t.spacing.base, paddingVertical: 8, marginTop: 6,
  },
  grantHeader: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  grantName: {
    flex: 1, fontSize: 15, color: t.colors.textPrimary, fontWeight: '600',
  },
  removeBtn: { marginLeft: 12 },
  removeText: { color: t.colors.danger, fontSize: 13, fontWeight: '600' },
  addLink: { color: t.colors.primary, fontSize: 14, fontWeight: '700', paddingVertical: 8 },
  disabled: { opacity: 0.5 },

  cancelRow: { paddingVertical: 10, alignItems: 'center', marginBottom: 4 },
  linkText: { color: t.colors.primary, fontSize: 15, fontWeight: '600' },
  cancelText: { color: t.colors.textMuted },
});
