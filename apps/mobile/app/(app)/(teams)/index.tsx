import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useRouter } from 'expo-router';
import { generateUUID } from '../../../src/utils/uuid';
import { getAllTeams, upsertTeam, Team } from '../../../src/db/queries/teams';
import { appendOutbox } from '../../../src/sync/outbox';
import { appendLog } from '../../../src/db/queries/log';
import { runInTransaction } from '../../../src/db/tx';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { getTaxonomyTypes, getTaxonomyTypesWithFallback, getTypeIcon } from '../../../src/db/queries/taxonomy';
import { renderIcon } from '../../../src/constants/locationStyles';
import { colors } from '../../../src/theme';
import { syncNow } from '../../../src/sync/engine';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { Card } from '../../../src/components/ui/Card';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { TooltipHint } from '../../../src/components/TooltipHint';
import { useDataVersion } from '../../../src/hooks/useDataVersion';

export default function TeamsScreen() {
  const router = useRouter();
  const { user } = useSession();
  const canManage = usePermission('manage_teams');

  const [teams, setTeams] = useState<Team[]>(() => getAllTeams());
  const [showCreate, setShowCreate] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const dataVersion = useDataVersion();

  // Re-read teams whenever a background sync pull applies changes, so an
  // already-open list refreshes without a manual pull-to-refresh.
  useEffect(() => {
    setTeams(getAllTeams());
  }, [dataVersion]);

  // Create form state
  const [name, setName] = useState('');
  const [type, setType] = useState(() => {
    const ts = getTaxonomyTypes('team');
    return ts[0]?.label ?? '';
  });

  const teamTypes = useMemo(() => getTaxonomyTypesWithFallback('team'), []);

  function resetForm() {
    setName('');
    setType(teamTypes[0]?.label ?? '');
  }

  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — local reload still runs */ }
    setTeams(getAllTeams());
    setRefreshing(false);
  }, [refreshing]);

  function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert('Required', 'Enter a team name.');
      return;
    }

    const id = generateUUID();
    const now = new Date().toISOString();
    // manager_id is legacy/deprecated — managers are flagged per-member (is_manager)
    // on the team detail screen after creation. Leave it unset here.
    const team: Team = {
      id,
      name: trimmed,
      type,
      manager_id: null,
      updated_at: now,
      synced_at: null,
    };

    try {
      runInTransaction(() => {
        upsertTeam(team);
        appendOutbox('INSERT', 'teams', {
          id,
          name: trimmed,
          type,
          manager_id: null,
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
      });
    } catch (e) {
      Alert.alert('Could not create team', `"${trimmed}" was not created. Please try again.`);
      return;
    }

    // Success side-effects only after the write committed.
    setTeams(getAllTeams());
    setShowCreate(false);
    resetForm(); // clear only after successful submit
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Teams', headerShown: true }} />
      <View style={s.container}>
        <TooltipHint screenKey="teams" />

        {canManage && (
          <View style={s.topBar}>
            <Text style={s.subtitle}>
              {teams.length} team{teams.length === 1 ? '' : 's'}
            </Text>
            <TouchableOpacity style={s.addBtn} onPress={() => setShowCreate(true)}>
              <Text style={s.addBtnText}>+ New</Text>
            </TouchableOpacity>
          </View>
        )}

        <FlatList
          data={teams}
          keyExtractor={t => t.id}
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          renderItem={({ item: team }) => {
            const typeIcon = getTypeIcon('team', team.type);
            return (
              <TouchableOpacity
                onPress={() => router.push({ pathname: '/(app)/(teams)/[id]', params: { id: team.id } })}
              >
                <Card variant="list">
                  <Text style={s.name}>{team.name}</Text>
                  <Text style={s.type}>{typeIcon ? `${typeIcon} ${team.type}` : team.type}</Text>
                </Card>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={s.emptyText}>
                No teams set up yet{canManage ? '. Tap "+ New" to create one.' : '.'}
              </Text>
            </View>
          }
        />

        {/* Create team modal — onClose only hides; inputs are preserved on outside-tap dismiss */}
        <ModalSheet visible={showCreate} onClose={() => setShowCreate(false)}>
            <Text style={s.modalTitle}>New Team</Text>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
              <AppInput
                placeholder="Team name *"
                value={name}
                onChangeText={setName}
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
                    active={type === t.label}
                    onPress={() => setType(t.label)}
                  />
                ))}
              </ScrollView>

              <PrimaryButton label="Create Team" onPress={handleCreate} style={{ marginTop: 8 }} />
              <View style={s.secondaryRow}>
                <TouchableOpacity style={s.linkBtn} onPress={resetForm}>
                  <Text style={s.linkText}>Clear</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={s.linkBtn}
                  onPress={() => setShowCreate(false)}
                >
                  <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </ScrollView>
        </ModalSheet>
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
  },
  subtitle: { fontSize: 13, color: colors.textSecondary, fontWeight: '600' },
  addBtn: { backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8 },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  list: { padding: 12, gap: 8, paddingBottom: 48 },
  name: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  type: { fontSize: 12, color: colors.textSecondary, marginTop: 2, textTransform: 'capitalize' },
  empty: { alignItems: 'center', paddingTop: 40, paddingHorizontal: 24 },
  emptyText: { fontSize: 14, color: colors.textMuted, textAlign: 'center' },

  modalTitle: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginBottom: 14 },
  chipRow: { gap: 8, paddingRight: 8 },
  secondaryRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 4, marginBottom: 8 },
  linkBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  linkText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
  cancelText: { color: colors.textMuted },
});
