import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, RefreshControl } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useRouter } from 'expo-router';
import { generateUUID } from '../../../src/utils/uuid';
import { getAllTeams, getTeamMembers, upsertTeam, Team } from '../../../src/db/queries/teams';
import { ROLE_TIER } from '../../../src/constants/roles';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { appendOutbox } from '../../../src/sync/outbox';
import { appendLog } from '../../../src/db/queries/log';
import { runInTransaction } from '../../../src/db/tx';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { getTaxonomyTypes, getTaxonomyTypesWithFallback, getTypeIcon } from '../../../src/db/queries/taxonomy';
import type { Theme } from '../../../src/themes/types';
import { useTheme } from '../../../src/hooks/useTheme';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import { syncNow } from '../../../src/sync/engine';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { TaxonomyChips } from '../../../src/components/pickers';
import { Card } from '../../../src/components/ui/Card';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { TooltipHint } from '../../../src/components/TooltipHint';
import { useDataVersion } from '../../../src/hooks/useDataVersion';

export default function TeamsScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
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

  // Client mirror of the server's isOrgAuthority (effectiveTier(role) >= 3, tiers
  // office_manager/hr_manager/franchise_manager/full_admin). Deliberately keyed on
  // ROLE_TIER, NOT the manage_teams permission — tier-2 leads hold manage_teams but
  // are not org authority. ROLE_TIER has no apex bump, but every tier >= 3 role is
  // already >= 3 there, so it matches the server threshold; unknown roles fail closed.
  const isOrgAuthority = !!user && (ROLE_TIER[user.role] ?? 0) >= 3;

  // "My Teams" = teams whose local team_members row names the authenticated user,
  // with the manager flag for the badge. Filtering here from getAllTeams/getTeamMembers
  // is safe because the device no longer holds foreign teams (sync scopes them away);
  // the server is the enforcement of record, this split is only presentation.
  const myTeams = useMemo(() => {
    if (!user) return [];
    return teams
      .map(team => {
        const mine = getTeamMembers(team.id).find(m => m.user_id === user.id);
        return mine ? { team, isManager: mine.is_manager === 1 } : null;
      })
      .filter((m): m is { team: Team; isManager: boolean } => m !== null);
  }, [teams, user]);

  // Create form state. Seeded synchronously, not via TaxonomyChips' defaultToFirst:
  // ModalSheet's <Modal> unmounts its children while hidden, so the chip row
  // remounts on every open and a mount effect would paint one frame with nothing
  // selected before highlighting the default.
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
    // Managers are flagged per-member (is_manager) on the team detail screen
    // after creation; the deprecated teams.manager_id column was dropped (migration 026).
    const team: Team = {
      id,
      name: trimmed,
      type,
      updated_at: now,
      synced_at: null,
    };

    try {
      runInTransaction(() => {
        const typeId = upsertTeam(team);
        appendOutbox('INSERT', 'teams', {
          id,
          name: trimmed,
          type,
          type_id: typeId,
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

  function renderTeamCard(team: Team, isManager: boolean) {
    const typeIcon = getTypeIcon('team', team.type);
    return (
      <TouchableOpacity
        key={team.id}
        onPress={() => router.push({ pathname: '/(app)/(teams)/[id]', params: { id: team.id } })}
      >
        <Card variant="list">
          <View style={s.cardRow}>
            <View style={s.cardText}>
              <Text style={s.name}>{team.name}</Text>
              <Text style={s.type}>{typeIcon ? `${typeIcon} ${team.type}` : team.type}</Text>
            </View>
            {isManager ? <Text style={s.managerBadge}>Manager</Text> : null}
          </View>
        </Card>
      </TouchableOpacity>
    );
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

        <ScrollView
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={t.colors.primary}
              colors={[t.colors.primary]}
            />
          }
        >
          {isOrgAuthority ? (
            <>
              <Text style={s.sectionHeader}>My Teams</Text>
              {myTeams.length
                ? myTeams.map(m => renderTeamCard(m.team, m.isManager))
                : <Text style={s.sectionEmpty}>You're not on a team yet.</Text>}

              <Text style={s.sectionHeader}>All Teams</Text>
              {teams.length
                ? teams.map(team => renderTeamCard(team, false))
                : <Text style={s.sectionEmpty}>
                    No teams set up yet{canManage ? '. Tap "+ New" to create one.' : '.'}
                  </Text>}
            </>
          ) : myTeams.length ? (
            myTeams.map(m => renderTeamCard(m.team, m.isManager))
          ) : (
            <EmptyState
              icon="👥"
              title="You're not on a team yet"
              subtitle="Ask an admin to add you to a team to see it here."
            />
          )}
        </ScrollView>

        {/* Create team modal — onClose only hides; inputs are preserved on outside-tap dismiss */}
        <ModalSheet visible={showCreate} onClose={() => setShowCreate(false)}>
            <Text style={s.modalTitle}>New Team</Text>
            <ScrollView style={{ flexShrink: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
              <AppInput
                placeholder="Team name *"
                value={name}
                onChangeText={setName}
                autoFocus
              />

              <TaxonomyChips
                category="team"
                label="Type"
                withFallback
                valueLabel={type}
                onChange={v => setType(v.label ?? '')}
              />

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

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
  },
  subtitle: { fontSize: 13, color: t.colors.textSecondary, fontWeight: '600' },
  addBtn: { backgroundColor: t.colors.primary, borderRadius: 10, paddingHorizontal: 16, paddingVertical: 8 },
  addBtnText: { color: t.colors.onPrimary, fontWeight: '700', fontSize: 14 },
  list: { padding: 12, gap: 8, paddingBottom: 48 },
  sectionHeader: {
    fontSize: 12, fontWeight: '700', color: t.colors.textSecondary,
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 8, marginBottom: 2, paddingHorizontal: 4,
  },
  sectionEmpty: { fontSize: 13, color: t.colors.textMuted, paddingHorizontal: 4, paddingVertical: 8 },
  cardRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardText: { flex: 1 },
  managerBadge: {
    fontSize: 11, fontWeight: '700', color: t.colors.primary,
    backgroundColor: t.colors.primaryBg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3,
    overflow: 'hidden',
  },
  name: { fontSize: 15, fontWeight: '600', color: t.colors.textPrimary },
  type: { fontSize: 12, color: t.colors.textSecondary, marginTop: 2, textTransform: 'capitalize' },

  modalTitle: { fontSize: 18, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 14 },
  secondaryRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 4, marginBottom: 8 },
  linkBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  linkText: { color: t.colors.primary, fontSize: 15, fontWeight: '600' },
  cancelText: { color: t.colors.textMuted },
});
