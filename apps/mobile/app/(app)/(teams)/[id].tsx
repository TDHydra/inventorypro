import { useState, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
  TextInput, Modal, Alert, KeyboardAvoidingView, Platform,
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

// keep in sync with index.tsx
const TEAM_TYPES = ['operations', 'management', 'construction', 'contents', 'cleaning', 'admin', 'other'];

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
    setNewMemberOption(null);
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
        <View style={s.card}>
          <Text style={s.teamName}>{team.name}</Text>
          <View style={s.attrRow}>
            <Text style={s.attrKey}>Type</Text>
            <Text style={s.attrVal}>{team.type}</Text>
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
        </View>

        {/* Roster */}
        <View style={s.sectionHeader}>
          <Text style={s.sectionLabel}>Members ({members.length})</Text>
          {canManage && (
            <TouchableOpacity onPress={() => { setNewMemberOption(null); setShowAddMember(true); }}>
              <Text style={s.addLink}>+ Add</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={s.card}>
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
        </View>

      </ScrollView>

      {/* Edit team modal */}
      <Modal visible={showEdit} animationType="slide" transparent>
        <KeyboardAvoidingView
          style={s.overlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={s.modal}>
            <Text style={s.modalTitle}>Edit Team</Text>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
              <TextInput
                style={s.input}
                placeholder="Team name *"
                placeholderTextColor="#94A3B8"
                value={editName}
                onChangeText={setEditName}
                autoFocus
              />

              <Text style={s.label}>Type</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.chipRow}
              >
                {TEAM_TYPES.map(t => (
                  <TouchableOpacity
                    key={t}
                    style={[s.chip, editType === t && s.chipActive]}
                    onPress={() => setEditType(t)}
                  >
                    <Text style={[s.chipText, editType === t && s.chipTextActive]}>{t}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <Text style={s.label}>Manager (optional)</Text>
              <SearchablePicker
                placeholder="Search people…"
                options={userOptions}
                value={editManagerOption}
                onSelect={(opt) => {
                  setEditManagerOption(prev => (prev?.id === opt.id ? null : opt));
                }}
              />

              <TouchableOpacity style={s.btn} onPress={handleSaveEdit}>
                <Text style={s.btnText}>Save Changes</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.cancelRow}
                onPress={() => setShowEdit(false)}
              >
                <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* Add member modal */}
      <Modal visible={showAddMember} animationType="slide" transparent>
        <KeyboardAvoidingView
          style={s.overlay}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={s.modal}>
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

              <TouchableOpacity
                style={[s.btn, !newMemberOption && s.btnDisabled]}
                onPress={handleAddMember}
                disabled={!newMemberOption}
              >
                <Text style={s.btnText}>Add to Team</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={s.cancelRow}
                onPress={() => { setShowAddMember(false); setNewMemberOption(null); }}
              >
                <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 14, color: '#94A3B8' },

  card: {
    backgroundColor: '#fff', borderRadius: 12, padding: 16,
    borderWidth: 1, borderColor: '#EEF2F7',
  },
  teamName: { fontSize: 22, fontWeight: '700', color: '#1E3A5F', marginBottom: 8 },

  attrRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10,
  },
  attrKey: { fontSize: 14, color: '#64748B' },
  attrVal: {
    fontSize: 14, color: '#1E293B', fontWeight: '600',
    maxWidth: '60%', textAlign: 'right', textTransform: 'capitalize',
  },
  divider: { borderTopWidth: 1, borderTopColor: '#F1F5F9' },

  editBtn: {
    marginTop: 12, backgroundColor: '#EFF6FF', borderRadius: 10,
    paddingVertical: 10, alignItems: 'center',
  },
  editBtnText: { color: '#1D4ED8', fontWeight: '700', fontSize: 14 },

  sectionHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
  },
  sectionLabel: {
    fontSize: 12, fontWeight: '700', color: '#64748B',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  addLink: { color: '#2563EB', fontSize: 14, fontWeight: '700' },

  memberRow: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
  },
  memberName: { fontSize: 15, color: '#1E293B', fontWeight: '600' },
  memberRole: { fontSize: 12, color: '#64748B', marginTop: 2 },
  removeText: { color: '#DC2626', fontSize: 13, fontWeight: '600' },

  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  modal: {
    backgroundColor: '#F8FAFF', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, maxHeight: '85%',
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1E293B', marginBottom: 14 },
  input: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, height: 44, fontSize: 14, color: '#1E293B',
  },
  label: {
    fontSize: 12, fontWeight: '700', color: '#64748B',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  chipRow: { gap: 8, paddingRight: 8 },
  chip: { backgroundColor: '#F1F5F9', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: '#DBEAFE' },
  chipText: { fontSize: 13, color: '#475569' },
  chipTextActive: { color: '#1D4ED8', fontWeight: '600' },
  btn: {
    backgroundColor: '#2563EB', borderRadius: 12,
    paddingVertical: 13, alignItems: 'center', marginTop: 8,
  },
  btnDisabled: { backgroundColor: '#94A3B8' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  cancelRow: { paddingVertical: 10, alignItems: 'center', marginBottom: 4 },
  linkText: { color: '#2563EB', fontSize: 15, fontWeight: '600' },
  cancelText: { color: '#94A3B8' },
});
