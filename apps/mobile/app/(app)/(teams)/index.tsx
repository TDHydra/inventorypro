import { useState, useMemo } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  TextInput, Modal, Alert, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { generateUUID } from '../../../src/utils/uuid';
import { getAllTeams, upsertTeam, Team } from '../../../src/db/queries/teams';
import { appendOutbox } from '../../../src/sync/outbox';
import { appendLog } from '../../../src/db/queries/log';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { getAllActiveUsers } from '../../../src/db/queries/users';
import { ROLE_DISPLAY_NAMES } from '../../../src/constants/roles';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';

// keep in sync with [id].tsx
const TEAM_TYPES = ['operations', 'management', 'construction', 'contents', 'cleaning', 'admin', 'other'];

export default function TeamsScreen() {
  const router = useRouter();
  const { user } = useSession();
  const canManage = usePermission('manage_teams');

  const [teams, setTeams] = useState<Team[]>(() => getAllTeams());
  const [showCreate, setShowCreate] = useState(false);

  // Create form state
  const [name, setName] = useState('');
  const [type, setType] = useState(TEAM_TYPES[0]);
  const [managerOption, setManagerOption] = useState<PickerOption | null>(null);

  const allUsers = useMemo(() => getAllActiveUsers(), []);
  const userOptions = useMemo<PickerOption[]>(
    () => allUsers.map(u => ({ id: u.id, label: u.name, sublabel: ROLE_DISPLAY_NAMES[u.role] })),
    [allUsers],
  );

  function resetForm() {
    setName('');
    setType(TEAM_TYPES[0]);
    setManagerOption(null);
  }

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert('Required', 'Enter a team name.');
      return;
    }

    const id = generateUUID();
    const now = new Date().toISOString();
    const team: Team = {
      id,
      name: trimmed,
      type,
      manager_id: managerOption?.id ?? null,
      updated_at: now,
      synced_at: null,
    };

    upsertTeam(team);
    appendOutbox('INSERT', 'teams', {
      id,
      name: trimmed,
      type,
      manager_id: managerOption?.id ?? null,
      updated_at: now,
    });
    appendLog({
      user_id: user?.id ?? null,
      team_id: id,
      action: 'team_created',
      entity_type: 'team',
      entity_id: id,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      note: trimmed,
      metadata: null,
      device_id: null,
    });

    setTeams(getAllTeams());
    setShowCreate(false);
    resetForm();
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Teams', headerShown: true }} />
      <View style={s.container}>
        {canManage && (
          <View style={s.topBar}>
            <Text style={s.subtitle}>
              {teams.length} team{teams.length === 1 ? '' : 's'}
            </Text>
            <TouchableOpacity style={s.addBtn} onPress={() => { resetForm(); setShowCreate(true); }}>
              <Text style={s.addBtnText}>+ New</Text>
            </TouchableOpacity>
          </View>
        )}

        <FlatList
          data={teams}
          keyExtractor={t => t.id}
          contentContainerStyle={s.list}
          renderItem={({ item: team }) => (
            <TouchableOpacity
              style={s.card}
              onPress={() => router.push({ pathname: '/(app)/(teams)/[id]', params: { id: team.id } })}
            >
              <Text style={s.name}>{team.name}</Text>
              <Text style={s.type}>{team.type}</Text>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={s.emptyText}>
                No teams set up yet{canManage ? '. Tap "+ New" to create one.' : '.'}
              </Text>
            </View>
          }
        />

        {/* Create team modal */}
        <Modal visible={showCreate} animationType="slide" transparent>
          <KeyboardAvoidingView
            style={s.overlay}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View style={s.modal}>
              <Text style={s.modalTitle}>New Team</Text>
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
                <TextInput
                  style={s.input}
                  placeholder="Team name *"
                  placeholderTextColor="#94A3B8"
                  value={name}
                  onChangeText={setName}
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
                      style={[s.chip, type === t && s.chipActive]}
                      onPress={() => setType(t)}
                    >
                      <Text style={[s.chipText, type === t && s.chipTextActive]}>{t}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>

                <Text style={s.label}>Manager (optional)</Text>
                <SearchablePicker
                  placeholder="Search people…"
                  options={userOptions}
                  value={managerOption}
                  onSelect={(opt) => {
                    setManagerOption(prev => (prev?.id === opt.id ? null : opt));
                  }}
                />

                <TouchableOpacity style={s.btn} onPress={handleCreate}>
                  <Text style={s.btnText}>Create Team</Text>
                </TouchableOpacity>
                <View style={s.secondaryRow}>
                  <TouchableOpacity style={s.linkBtn} onPress={resetForm}>
                    <Text style={s.linkText}>Clear</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={s.linkBtn}
                    onPress={() => { setShowCreate(false); resetForm(); }}
                  >
                    <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </ScrollView>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF' },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
  },
  subtitle: { fontSize: 13, color: '#64748B', fontWeight: '600' },
  addBtn: { backgroundColor: '#2563EB', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8 },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  list: { padding: 12, gap: 8, paddingBottom: 48 },
  card: {
    backgroundColor: '#fff', borderRadius: 10, padding: 14,
    borderWidth: 1, borderColor: '#E2E8F0',
  },
  name: { fontSize: 15, fontWeight: '600', color: '#1E293B' },
  type: { fontSize: 12, color: '#64748B', marginTop: 2, textTransform: 'capitalize' },
  empty: { alignItems: 'center', paddingTop: 40, paddingHorizontal: 24 },
  emptyText: { fontSize: 14, color: '#94A3B8', textAlign: 'center' },

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
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 4, marginBottom: 8 },
  linkBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  linkText: { color: '#2563EB', fontSize: 15, fontWeight: '600' },
  cancelText: { color: '#94A3B8' },
});
