import { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Switch,
} from 'react-native';
import { generateUUID } from '../../utils/uuid';
import {
  upsertTeam, addTeamMember, TEAM_OVERRIDABLE_PERMISSIONS, TEAM_PERMISSION_LABELS,
} from '../../db/queries/teams';
import type { Team } from '../../db/queries/teams';
import { getAllActiveUsers, getRolePermissionOverrides } from '../../db/queries/users';
import { getTaxonomyTypes } from '../../db/queries/taxonomy';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { runInTransaction } from '../../db/tx';
import { useSession } from '../../hooks/useSession';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { useTableVersion } from '../../hooks/useDataVersion';
import { Alert } from '../../lib/themedAlert';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';
import { TaxonomyChips } from '../pickers';
import { ROLE_DEFAULTS, UserRole, Permission } from '../../constants/roles';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { AppInput } from '../ui/AppInput';
import { FieldLabel } from '../ui/FieldLabel';
import { FormScreen } from '../ui/FormScreen';
import { PrimaryButton } from '../ui/PrimaryButton';
import { ModalSheet } from '../ui/ModalSheet';
import { PermissionGate } from '../PermissionGate';
import { QuickAddFooter } from './QuickAddFooter';
import { track } from '../../telemetry';
import { validateName } from '../../lib/validation';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

// A member queued to be added once the team itself is created — not persisted
// until Save (addTeamMember/appendOutbox run inside the same transaction as the
// team INSERT below).
interface PendingMember {
  user: PickerOption;
  role: string;
  overrides: Record<string, boolean>;
}

export default function TeamQuickAdd({ onSaved }: Props) {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();

  // Re-read pickers/bases when a sync (or local write) touches their tables,
  // so e.g. the PM picker sees newly synced users.
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

    const now = new Date().toISOString();
    const id = generateUUID();

    // Managers are flagged per-member (is_manager) on the team detail screen
    // after creation, via the gated PATCH endpoint — the legacy teams.manager_id
    // column has been dropped server-side (and locally in migration 026).
    const team: Team = {
      id,
      name: trimmedName,
      type,
      updated_at: now,
      synced_at: null,
    };

    try {
      runInTransaction(() => {
        const typeId = upsertTeam(team);
        // synced_at is local-only — strip from the outbox payload (server has no such column).
        const { synced_at: _s, ...teamRow } = team;
        appendOutbox('INSERT', 'teams', { ...teamRow, type_id: typeId });
        appendLog({
          action: 'team_created',
          entity_type: 'team',
          entity_id: id,
          user_id: user?.id ?? null,
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
        // detail screen's "Add Member" flow (addTeamMember/team_member_added).
        for (const pm of pendingMembers) {
          const added = addTeamMember(id, pm.user.id, pm.overrides, user?.id ?? null);
          if (!added) continue; // defensive — can't happen on a brand-new team
          appendOutbox('INSERT', 'team_members', {
            team_id: id,
            user_id: pm.user.id,
            team_permission_overrides: JSON.stringify(pm.overrides),
            added_by: user?.id ?? null,
            joined_at: added.joined_at,
          });
          appendLog({
            user_id: user?.id ?? null,
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

    onSaved(trimmedName, id);
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
        onChangeText={t => { setName(t); if (nameError) setNameError(''); }}
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
