import { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  Alert,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import {
  getTeamById, getTeamMembers, upsertTeam, addTeamMember, removeTeamMember,
  Team, TeamMember,
} from '../../../src/db/queries/teams';
import { appendOutbox } from '../../../src/sync/outbox';
import { appendLog } from '../../../src/db/queries/log';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { getAllActiveUsers } from '../../../src/db/queries/users';
import { ROLE_DISPLAY_NAMES, UserRole } from '../../../src/constants/roles';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { getTaxonomyTypes, getTypeIcon } from '../../../src/db/queries/taxonomy';
import { renderIcon } from '../../../src/constants/locationStyles';
import { colors } from '../../../src/theme';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { Card } from '../../../src/components/ui/Card';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';

export default function TeamDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const canManage = usePermission('manage_teams');

  const [team, setTeam] = useState<Team | null>(() => getTeamById(id));
  const [members, setMembers] = useState<TeamMember[]>(() => getTeamMembers(id));

  // Edit modal
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState('');
  const [editManagerOption, setEditManagerOption] = useState<PickerOption | null>(null);

  // Add member modal
  const [showAddMember, setShowAddMember] = useState(false);
  const [newMemberOption, setNewMemberOption] = useState<PickerOption | null>(null);

  const allUsers = useMemo(() => getAllActiveUsers(), []);
  const teamTypes = useMemo(() => getTaxonomyTypes('team'), []);
  const userOptions = useMemo<PickerOption[]>(
    () => allUsers.map(u => ({ id: u.id, label: u.name, sublabel: ROLE_DISPLAY_NAMES[u.role] })),
    [allUsers],
  );

  const managerName = useMemo(() => {
    if (!team?.manager_id) return null;
    return allUsers.find(u => u.id === team.manager_id)?.name ?? team.manager_id;
  }, [team?.manager_id, allUsers]);

  // Users not already on the team (for Add Member picker)
  const memberIds = useMemo(() => new Set(members.map(m => m.user_id)), [members]);
  const nonMemberOptions = useMemo<PickerOption[]>(
    () => userOptions.filter(o => !memberIds.has(o.id)),
    [userOptions, memberIds],
  );

  // ── Edit team ──────────────────────────────────────────────────────────────

  function openEdit() {
    if (!team) return;
    setEditName(team.name);
    setEditType(team.type);
    const mgr = team.manager_id
      ? (userOptions.find(o => o.id === team.manager_id) ?? null)
      : null;
    setEditManagerOption(mgr);
    setShowEdit(true);
  }

  function handleSaveEdit() {
    if (!team) return;
    const trimmed = editName.trim();
    if (!trimmed) {
      Alert.alert('Required', 'Enter a team name.');
      return;
    }
    const now = new Date().toISOString();
    const updated: Team = {
      ...team,
      name: trimmed,
      type: editType,
      manager_id: editManagerOption?.id ?? null,
      updated_at: now,
    };
    upsertTeam(updated);
    appendOutbox('UPDATE', 'teams', {
      id: team.id,
      name: trimmed,
      type: editType,
      manager_id: editManagerOption?.id ?? null,
      updated_at: now,
    });
    appendLog({
      user_id: user?.id ?? null,
      team_id: team.id,
      action: 'team_updated',
      entity_type: 'team',
      entity_id: team.id,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      note: null,
      metadata: null,
      device_id: null,
    });
    setTeam(updated);
    setShowEdit(false);
  }

  // ── Add member ─────────────────────────────────────────────────────────────

  function handleAddMember() {
    if (!newMemberOption || !team) return;
    const result = addTeamMember(team.id, newMemberOption.id, {}, user?.id ?? null);
    if (result === null) {
      // INSERT OR IGNORE skipped — composite key already exists
      Alert.alert('Already a member', `${newMemberOption.label} is already on this team.`);
      setNewMemberOption(null);
      setShowAddMember(false);
      return;
    }
    const { joined_at } = result;
    appendOutbox('INSERT', 'team_members', {
      team_id: team.id,
      user_id: newMemberOption.id,
      team_permission_overrides: '{}',
      added_by: user?.id ?? null,
      joined_at,
    });
    appendLog({
      user_id: user?.id ?? null,
      team_id: team.id,
      action: 'team_member_added',
      entity_type: 'team',
      entity_id: team.id,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      note: newMemberOption.label,
      metadata: JSON.stringify({ member_user_id: newMemberOption.id }),
      device_id: null,
    });
    setMembers(getTeamMembers(team.id));
    setNewMemberOption(null); // clear only after successful submit
    setShowAddMember(false);
  }

  // ── Remove member ──────────────────────────────────────────────────────────

  function handleRemoveMember(member: TeamMember) {
    if (!team) return;
    const memberName = member.user_name ?? member.user_id;
    Alert.alert(
      'Remove Member',
      `Remove ${memberName} from this team?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            removeTeamMember(team.id, member.user_id);
            // Composite-key DELETE: server matches by {team_id, user_id}
            appendOutbox('DELETE', 'team_members', {
              team_id: team.id,
              user_id: member.user_id,
            });
            appendLog({
              user_id: user?.id ?? null,
              team_id: team.id,
              action: 'team_member_removed',
              entity_type: 'team',
              entity_id: team.id,
              from_location_id: null,
              to_location_id: null,
              quantity: null,
              unit: null,
              job_id: null,
              note: memberName,
              metadata: JSON.stringify({ member_user_id: member.user_id }),
              device_id: null,
            });
            setMembers(getTeamMembers(team.id));
          },
        },
      ],
    );
  }

  // ── Not found ──────────────────────────────────────────────────────────────

  if (!team) {
    return (
      <>
        <Stack.Screen options={{ title: 'Team', headerShown: true }} />
        <View style={s.center}>
          <Text style={s.muted}>Team not found.</Text>
        </View>
      </>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <>
      <Stack.Screen options={{ title: team.name, headerShown: true }} />
      <ScrollView contentContainerStyle={s.content}>

        {/* Header card */}
        <Card variant="detail">
          <Text style={s.teamName}>{team.name}</Text>
          <View style={s.attrRow}>
            <Text style={s.attrKey}>Type</Text>
            <Text style={s.attrVal}>{(() => { const icon = getTypeIcon('team', team.type); return icon ? `${icon} ${team.type}` : team.type; })()}</Text>
          </View>
          {!!managerName && (
            <View style={[s.attrRow, s.divider]}>
              <Text style={s.attrKey}>Manager</Text>
              <Text style={s.attrVal}>{managerName}</Text>
            </View>
          )}
          {canManage && (
            <TouchableOpacity style={s.editBtn} onPress={openEdit}>
              <Text style={s.editBtnText}>Edit Team</Text>
            </TouchableOpacity>
          )}
        </Card>

        {/* Roster */}
        <View style={s.sectionHeader}>
          <Text style={s.sectionLabel}>Members ({members.length})</Text>
          {canManage && (
            <TouchableOpacity onPress={() => setShowAddMember(true)}>
              <Text style={s.addLink}>+ Add</Text>
            </TouchableOpacity>
          )}
        </View>

        <Card variant="detail">
          {members.length === 0 ? (
            <Text style={s.muted}>
              No members yet{canManage ? '. Tap "+ Add" to add someone.' : '.'}
            </Text>
          ) : (
            members.map((m, i) => (
              <View
                key={m.user_id}
                style={[s.memberRow, i < members.length - 1 && s.divider]}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.memberName}>{m.user_name ?? m.user_id}</Text>
                  {!!m.user_role && (
                    <Text style={s.memberRole}>
                      {ROLE_DISPLAY_NAMES[m.user_role as UserRole] ?? m.user_role}
                    </Text>
                  )}
                </View>
                {canManage && (
                  <TouchableOpacity
                    onPress={() => handleRemoveMember(m)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={s.removeText}>Remove</Text>
                  </TouchableOpacity>
                )}
              </View>
            ))
          )}
        </Card>

      </ScrollView>

      {/* Edit team modal — onClose only hides; inputs are preserved on outside-tap dismiss */}
      <ModalSheet visible={showEdit} onClose={() => setShowEdit(false)}>
          <Text style={s.modalTitle}>Edit Team</Text>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
            <AppInput
              placeholder="Team name *"
              value={editName}
              onChangeText={setEditName}
              autoFocus
            />

            <FieldLabel>Type</FieldLabel>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={s.chipRow}
            >
              {teamTypes.map(t => (
                <FilterChip
                  key={t.label}
                  label={`${renderIcon(t.icon)} ${t.label}`}
                  active={editType === t.label}
                  onPress={() => setEditType(t.label)}
                />
              ))}
            </ScrollView>

            <FieldLabel>Manager (optional)</FieldLabel>
            <SearchablePicker
              placeholder="Search people…"
              options={userOptions}
              value={editManagerOption}
              onSelect={(opt) => {
                setEditManagerOption(prev => (prev?.id === opt.id ? null : opt));
              }}
            />

            <PrimaryButton label="Save Changes" onPress={handleSaveEdit} style={{ marginTop: 8 }} />
            <TouchableOpacity
              style={s.cancelRow}
              onPress={() => setShowEdit(false)}
            >
              <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
            </TouchableOpacity>
          </ScrollView>
      </ModalSheet>

      {/* Add member modal — onClose only hides; selection preserved on outside-tap dismiss */}
      <ModalSheet visible={showAddMember} onClose={() => setShowAddMember(false)}>
          <Text style={s.modalTitle}>Add Team Member</Text>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
            {nonMemberOptions.length === 0 ? (
              <Text style={s.muted}>All active users are already on this team.</Text>
            ) : (
              <SearchablePicker
                placeholder="Search people…"
                options={nonMemberOptions}
                value={newMemberOption}
                onSelect={(opt) => {
                  setNewMemberOption(prev => (prev?.id === opt.id ? null : opt));
                }}
                autoFocus
              />
            )}

            <PrimaryButton
              label="Add to Team"
              onPress={handleAddMember}
              disabled={!newMemberOption}
              style={{ marginTop: 8 }}
            />
            <TouchableOpacity
              style={s.cancelRow}
              onPress={() => setShowAddMember(false)}
            >
              <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
            </TouchableOpacity>
          </ScrollView>
      </ModalSheet>
    </>
  );
}

const s = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 14, color: colors.textMuted },

  teamName: { fontSize: 22, fontWeight: '700', color: colors.brand, marginBottom: 8 },

  attrRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10,
  },
  attrKey: { fontSize: 14, color: colors.textSecondary },
  attrVal: {
    fontSize: 14, color: colors.textPrimary, fontWeight: '600',
    maxWidth: '60%', textAlign: 'right', textTransform: 'capitalize',
  },
  divider: { borderTopWidth: 1, borderTopColor: '#F1F5F9' },

  editBtn: {
    marginTop: 12, backgroundColor: colors.primaryBg, borderRadius: 10,
    paddingVertical: 10, alignItems: 'center',
  },
  editBtnText: { color: colors.primaryText, fontWeight: '700', fontSize: 14 },

  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  sectionLabel: {
    fontSize: 12, fontWeight: '700', color: colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  addLink: { color: colors.primary, fontSize: 14, fontWeight: '700' },

  memberRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
  },
  memberName: { fontSize: 15, color: colors.textPrimary, fontWeight: '600' },
  memberRole: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  removeText: { color: colors.danger, fontSize: 13, fontWeight: '600' },

  modalTitle: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginBottom: 14 },
  chipRow: { gap: 8, paddingRight: 8 },
  cancelRow: { paddingVertical: 10, alignItems: 'center', marginBottom: 4 },
  linkText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
  cancelText: { color: colors.textMuted },
});
