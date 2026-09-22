// Ported from apps/mobile/src/components/quickadd/TeamQuickAdd.tsx.
//
// Import mapping applied (docs/REBUILD-PORTING.md):
//   '../../db/queries/teams' (upsertTeam/addTeamMember/TEAM_OVERRIDABLE_PERMISSIONS/
//     TEAM_PERMISSION_LABELS) → '../../repos/teams' (createTeam/addTeamMember).
//   '../../db/queries/users' (getAllActiveUsers) → '../../repos/users'.
//   '../../db/queries/users' (getRolePermissionOverrides) → '../../repos/roleSettings'.
//   '../../sync/outbox' (appendOutbox) / '../../db/tx' (runInTransaction) →
//     '@invenpro/core' — no longer called directly here: createTeam/addTeamMember
//     self-mirror to the outbox, so this screen only needs runInTransaction to
//     make the team create + its pending-member adds one atomic unit (reentrant,
//     joins each repo call's own inner transaction).
//   Alert, AppInput, FieldLabel, FormScreen, PrimaryButton, ModalSheet, useTheme,
//     useThemedStyles → '@invenpro/ui'.
//   '../pickers' (TaxonomyChips) stays local — mobile-v2's own barrel.
import { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Switch,
} from 'react-native';
import type { Theme } from '@invenpro/ui';
import {
  Alert, AppInput, FieldLabel, FormScreen, PrimaryButton, ModalSheet, useTheme, useThemedStyles,
} from '@invenpro/ui';
import { runInTransaction } from '@invenpro/core';
import {
  createTeam, addTeamMember, TEAM_OVERRIDABLE_PERMISSIONS, TEAM_PERMISSION_LABELS,
} from '../../repos/teams';
import { getAllActiveUsers } from '../../repos/users';
import { getRolePermissionOverrides } from '../../repos/roleSettings';
import { getTaxonomyTypes } from '../../repos/taxonomy';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { useTableVersion } from '@invenpro/core';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';
import { TaxonomyChips } from '../pickers';
import { ROLE_DEFAULTS, UserRole, Permission } from '../../constants/roles';
import { PermissionGate } from '../PermissionGate';
import { QuickAddFooter } from './QuickAddFooter';
import { track } from '../../telemetry';
import { validateName } from '../../lib/validation';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

// A member queued to be added once the team itself is created — not persisted
// until Save (addTeamMember runs inside the same transaction as the team create).
interface PendingMember {
  user: PickerOption;
  role: string;
  overrides: Record<string, boolean>;
}

export default function TeamQuickAdd({ onSaved }: Props) {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();

  // Re-read pickers/bases when a sync (or local write) touches their tables,
  // so e.g. the member picker sees newly synced users.
  const version = useTableVersion(['taxonomy_types', 'users', 'role_settings']);

  const teamTypes = useMemo(() => getTaxonomyTypes('team'), [version]);
  const allUsers = useMemo(() => getAllActiveUsers(), [version]);
  // Role-level permission deviations, used as the "base" a team override is
  // relative to (mirrors the resolution order in auth/permissions.ts: role
  // default → role override → [team override, edited here] → user override).
  const roleOverrides = useMemo(() => getRolePermissionOverrides(), [version]);
  const userOptions: PickerOption[] = useMemo(
    () => allUsers.map(u => ({ id: u.id, label: u.name })),
    [allUsers],
  );
  const roleByUserId = useMemo(
    () => new Map(allUsers.map(u => [u.id, u.role as string])),
    [allUsers],
  );

  const [name, setName] = useState('');
  const [type, setType] = useState(() => teamTypes[0]?.label ?? '');
  const [nameError, setNameError] = useState('');

  // Members to add once the team is created (not yet persisted).
  const [pendingMembers, setPendingMembers] = useState<PendingMember[]>([]);
  const [memberOption, setMemberOption] = useState<PickerOption | null>(null);

  // Per-pending-member permission override editor (index into pendingMembers).
  const [permEditIdx, setPermEditIdx] = useState<number | null>(null);
  const [permDraft, setPermDraft] = useState<Record<string, boolean>>({});

  const pendingIds = useMemo(() => new Set(pendingMembers.map(p => p.user.id)), [pendingMembers]);
  const availableUserOptions = useMemo(
    () => userOptions.filter(o => !pendingIds.has(o.id)),
    [userOptions, pendingIds],
  );

  function baseTeamPermValue(role: string, perm: Permission): boolean {
    const r = role as UserRole;
    const def = ROLE_DEFAULTS[r]?.[perm] ?? false;
    const ov = roleOverrides[r];
    return ov && perm in ov ? ov[perm] : def;
  }

  function handleAddPendingMember() {
    if (!memberOption) return;
    setPendingMembers(prev => [
      ...prev,
      { user: memberOption, role: roleByUserId.get(memberOption.id) ?? '', overrides: {} },
    ]);
    setMemberOption(null);
  }

  function removePendingMember(idx: number) {
    setPendingMembers(prev => prev.filter((_, i) => i !== idx));
  }

  function openPermEditor(idx: number) {
    setPermEditIdx(idx);
    setPermDraft(pendingMembers[idx].overrides);
  }

  function togglePermDraft(perm: Permission) {
    if (permEditIdx === null) return;
    const base = baseTeamPermValue(pendingMembers[permEditIdx].role, perm);
    const cur = perm in permDraft ? permDraft[perm] : base;
    const next = !cur;
    setPermDraft(prev => {
      const copy = { ...prev };
      if (next === base) delete copy[perm]; else copy[perm] = next;
      return copy;
    });
  }

  function savePermDraft() {
    if (permEditIdx === null) return;
    setPendingMembers(prev => prev.map((p, i) => (i === permEditIdx ? { ...p, overrides: permDraft } : p)));
    setPermEditIdx(null);
  }

  function resetForm() {
    setName('');
    setType(teamTypes[0]?.label ?? '');
    setPendingMembers([]);
    setMemberOption(null);
  }

  function handleSave() {
    track('action', 'quickadd_save_team', { screen: 'quick_add' });
    // Bounded, control-char-free name (same 'Name is required.' copy as before
    // for the blank case).
    const nameResult = validateName(name);
    if (!nameResult.ok) {
      track('audit', 'validation_reject', { screen: 'quick_add', props: { field: 'team.name', rule: nameResult.rule } });
      setNameError(nameResult.error);
      return;
    }
    const trimmedName = nameResult.value;
    setNameError('');

    let createdId: string | null = null;
    try {
      runInTransaction(() => {
        // Managers are flagged per-member (is_manager) on the team detail screen
        // after creation, via the gated PATCH endpoint — the legacy teams.manager_id
        // column has been dropped server-side.
        const { id } = createTeam(trimmedName, type);
        createdId = id;
        appendLog({
          action: 'team_created',
          entity_type: 'team',
          entity_id: id,
          user_id: realUser?.id ?? null,
          team_id: id,
          job_id: null,
          note: trimmedName,
          from_location_id: null,
          to_location_id: null,
          quantity: null,
          unit: null,
          metadata: null,
          device_id: null,
        });

        // Add any members picked before Save, each with their (optional) per-team
        // permission overrides — same local-write + outbox pattern as the team
        // detail screen's "Add Member" flow.
        for (const pm of pendingMembers) {
          const added = addTeamMember(id, pm.user.id, pm.overrides, user?.id ?? null);
          if (!added) continue; // defensive — can't happen on a brand-new team
          appendLog({
            user_id: realUser?.id ?? null,
            team_id: id,
            action: 'team_member_added',
            entity_type: 'team',
            entity_id: id,
            from_location_id: null,
            to_location_id: null,
            quantity: null,
            unit: null,
            job_id: null,
            note: pm.user.label,
            metadata: JSON.stringify({ member_user_id: pm.user.id, overrides: pm.overrides }),
            device_id: null,
          });
        }
      });
    } catch (e) {
      Alert.alert('Could not create team', `"${trimmedName}" was not created. Please try again.`);
      return;
    }

    onSaved(trimmedName, createdId ?? undefined);
    resetForm(); // clear only after successful submit
  }

  return (
    // Owns its FormScreen (shell passes wrapForm={false}) so the Save/Done bar
    // sits in the sticky footer slot and floats above the keyboard (#118).
    <FormScreen
      contentContainerStyle={s.content}
      footer={(
        // server requires manage_teams for this privileged table (PRIVILEGED_TABLE_PERM) —
        // gate the save control so a denied user learns why instead of hitting
        // a sync conflict (#76).
        <PermissionGate permission="manage_teams" mode="disable">
          <QuickAddFooter onSave={handleSave} disabled={locked} locked={locked} />
        </PermissionGate>
      )}
    >
      <AppInput
        style={!!nameError && s.inputError}
        placeholder="Team name *"
        value={name}
        onChangeText={val => { setName(val); if (nameError) setNameError(''); }}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={handleSave}
      />
      {!!nameError && <Text style={s.errorText}>{nameError}</Text>}

      <TaxonomyChips
        category="team"
        label="Type"
        valueLabel={type}
        onChange={v => setType(v.label ?? '')}
      />

      <FieldLabel>Members (optional)</FieldLabel>
      <SearchablePicker
        placeholder="Search users..."
        options={availableUserOptions}
        value={memberOption}
        onSelect={opt => setMemberOption(prev => (prev?.id === opt.id ? null : opt))}
      />
      <TouchableOpacity
        style={[s.addMemberBtn, !memberOption && s.addMemberBtnOff]}
        onPress={handleAddPendingMember}
        disabled={!memberOption}
      >
        <Text style={s.addMemberBtnText}>+ Add to team</Text>
      </TouchableOpacity>

      {pendingMembers.length > 0 && (
        <View style={s.pendingList}>
          {pendingMembers.map((pm, i) => (
            <View key={pm.user.id} style={[s.pendingRow, i < pendingMembers.length - 1 && s.pendingDivider]}>
              <Text style={s.pendingName}>{pm.user.label}</Text>
              {Object.keys(pm.overrides).length > 0 && (
                <Text style={s.pendingOverrideBadge}>{Object.keys(pm.overrides).length} overridden</Text>
              )}
              <TouchableOpacity onPress={() => openPermEditor(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={s.pendingLink}>Perms</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => removePendingMember(i)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={[s.pendingLink, s.pendingRemove]}>Remove</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* Per-pending-member permission override editor — draft-only until the team
          (and its members) are actually created by Save. */}
      <ModalSheet visible={permEditIdx !== null} onClose={() => setPermEditIdx(null)} scroll={false}>
        <Text style={s.modalTitle}>
          {permEditIdx !== null ? `${pendingMembers[permEditIdx]?.user.label} · Team Permissions` : 'Team Permissions'}
        </Text>
        <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 4 }}>
          {permEditIdx !== null && TEAM_OVERRIDABLE_PERMISSIONS.map(perm => {
            const base = baseTeamPermValue(pendingMembers[permEditIdx].role, perm);
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
                  onValueChange={() => togglePermDraft(perm)}
                  trackColor={{ true: t.colors.primary, false: t.colors.border }}
                />
              </View>
            );
          })}
          <PrimaryButton label="Done" onPress={savePermDraft} style={{ marginTop: 8 }} />
        </ScrollView>
      </ModalSheet>
    </FormScreen>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // Mirrors the shell's default FormScreen content padding + this form's row gap.
  content: { padding: t.spacing.lg, paddingBottom: 48, gap: 10 },
  inputError: { borderColor: t.colors.danger },
  errorText: { fontSize: t.typography.fontSizes.caption, color: t.colors.danger, marginTop: -4 },

  addMemberBtn: {
    alignSelf: 'flex-start', backgroundColor: t.colors.primaryBg, borderRadius: t.radii.md,
    paddingHorizontal: 12, paddingVertical: 6, marginTop: 4,
  },
  addMemberBtnOff: { opacity: 0.4 },
  addMemberBtnText: { color: t.colors.primaryText, fontWeight: '700', fontSize: t.typography.fontSizes.sm },

  pendingList: { backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border },
  pendingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingHorizontal: 10 },
  pendingDivider: { borderBottomWidth: 1, borderBottomColor: t.colors.surfaceAlt },
  pendingName: { flex: 1, fontSize: t.typography.fontSizes.body2, color: t.colors.textPrimary, fontWeight: '600' },
  pendingOverrideBadge: { fontSize: t.typography.fontSizes.caption, color: t.colors.warning, fontWeight: '600' },
  pendingLink: { fontSize: t.typography.fontSizes.sm, color: t.colors.primary, fontWeight: '700' },
  pendingRemove: { color: t.colors.danger },

  modalTitle: { fontSize: 18, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 14 },
  permRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 10 },
  permLabel: { fontSize: 14, color: t.colors.textPrimary },
  modifiedBadge: { fontSize: 11, color: t.colors.warning, fontWeight: '600', marginTop: 2 },
});
