import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Switch, RefreshControl,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { getAllJobs, getActiveCheckoutsForUser, Job } from '../../../src/db/queries/jobs';
import { rowsAs } from '../../../src/db/schema';
import { colors } from '../../../src/theme';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { Card } from '../../../src/components/ui/Card';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { AppInput } from '../../../src/components/ui/AppInput';
import { TooltipHint } from '../../../src/components/TooltipHint';
import { syncNow } from '../../../src/sync/engine';

interface Checkout {
  log_id: string; entity_id: string; item_name: string;
  unit: string; unit_category: string; quantity: number;
  from_location_id: string | null; job_id: string | null;
  job_name: string | null; created_at: string;
}

type Tab = 'my' | 'all';
type StatusFilter = 'open' | 'closed' | 'all';

export default function JobsScreen() {
  const { user } = useSession();
  const router = useRouter();
  const canCreate = usePermission('create_jobs');
  const [tab, setTab] = useState<Tab>('my');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [showArchived, setShowArchived] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const reloadLocalData = useCallback(() => setReloadKey(k => k + 1), []);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — local reload still runs */ }
    reloadLocalData();
    setRefreshing(false);
  }, [refreshing, reloadLocalData]);

  const myCheckouts = useMemo(() => {
    if (!user) return [];
    return rowsAs<Checkout>(getActiveCheckoutsForUser(user.id));
  }, [user, reloadKey]);

  const allJobs = useMemo((): Job[] => {
    const jobs = getAllJobs(showArchived);
    const byStatus: Job[] = statusFilter === 'all'
      ? jobs
      : jobs.filter(j => j.status === statusFilter);
    if (!search.trim()) return byStatus;
    const q = search.trim().toLowerCase();
    return byStatus.filter(j => j.name.toLowerCase().includes(q));
  }, [search, statusFilter, showArchived, reloadKey]);

  return (
    <>
      <Stack.Screen options={{ title: 'Jobs', headerShown: true }} />
      <View style={s.container}>
        {canCreate && (
          <TouchableOpacity
            style={s.fab}
            onPress={() => router.push('/(app)/(jobs)/create')}
            accessibilityLabel="New Job"
          >
            <Text style={s.fabText}>+ New Job</Text>
          </TouchableOpacity>
        )}
        {/* Tabs */}
        <View style={s.tabs}>
          <TouchableOpacity
            style={[s.tab, tab === 'my' && s.tabActive]}
            onPress={() => setTab('my')}
          >
            <Text style={[s.tabText, tab === 'my' && s.tabTextActive]}>My Checkouts</Text>
            {myCheckouts.length > 0 && (
              <View style={s.badge}>
                <Text style={s.badgeText}>{myCheckouts.length}</Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.tab, tab === 'all' && s.tabActive]}
            onPress={() => setTab('all')}
          >
            <Text style={[s.tabText, tab === 'all' && s.tabTextActive]}>All Jobs</Text>
          </TouchableOpacity>
        </View>

        <TooltipHint screenKey="jobs" />

        {tab === 'my' ? (
          <FlatList
            data={myCheckouts}
            keyExtractor={c => c.log_id}
            contentContainerStyle={s.list}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={colors.primary}
                colors={[colors.primary]}
              />
            }
            renderItem={({ item }) => (
              <Card variant="list">
                <Text style={s.cardName}>{item.item_name}</Text>
                <Text style={s.cardSub}>
                  {item.quantity} {item.unit}{item.job_name ? ` · ${item.job_name}` : ''}
                </Text>
                <Text style={s.cardDate}>{new Date(item.created_at).toLocaleDateString()}</Text>
              </Card>
            )}
            ListEmptyComponent={<EmptyState title="No active checkouts" />}
          />
        ) : (
          <>
            {/* Search */}
            <View style={s.searchBox}>
              <AppInput
                placeholder="Search jobs..."
                value={search}
                onChangeText={setSearch}
                autoCapitalize="none"
              />
            </View>

            {/* Status filter chips + archived toggle */}
            <View style={s.filterRow}>
              {(['open', 'closed', 'all'] as StatusFilter[]).map(f => (
                <FilterChip
                  key={f}
                  label={f.charAt(0).toUpperCase() + f.slice(1)}
                  active={statusFilter === f}
                  onPress={() => setStatusFilter(f)}
                />
              ))}
              <View style={s.archivedToggle}>
                <Text style={s.archivedLabel}>Archived</Text>
                <Switch
                  value={showArchived}
                  onValueChange={setShowArchived}
                  trackColor={{ false: colors.textDisabled, true: colors.primaryBg }}
                  thumbColor={showArchived ? colors.primary : colors.surface}
                />
              </View>
            </View>

            <FlatList
              data={allJobs}
              keyExtractor={j => j.id}
              contentContainerStyle={s.list}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  tintColor={colors.primary}
                  colors={[colors.primary]}
                />
              }
              renderItem={({ item: job }) => (
                <TouchableOpacity
                  onPress={() =>
                    router.push({ pathname: '/(app)/(jobs)/[id]', params: { id: job.id } })
                  }
                >
                  <Card variant="list">
                    <Text style={s.cardName}>{job.name}</Text>
                    <View style={s.cardRow}>
                      <View style={[
                        s.statusDot,
                        job.status === 'open' ? s.statusOpen
                          : job.status === 'archived' ? s.statusArchived
                          : undefined,
                      ]} />
                      <Text style={s.cardSub}>{job.status}</Text>
                      <Text style={s.cardDate}>
                        {new Date(job.created_at).toLocaleDateString()}
                      </Text>
                    </View>
                  </Card>
                </TouchableOpacity>
              )}
              ListEmptyComponent={<EmptyState title="No jobs found" />}
            />
          </>
        )}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  tabs: {
    flexDirection: 'row', backgroundColor: colors.surface,
    borderBottomWidth: 1, borderBottomColor: colors.border,
  },
  tab: {
    flex: 1, paddingVertical: 12, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'center', gap: 6,
  },
  tabActive: { borderBottomWidth: 2, borderBottomColor: colors.primary },
  tabText: { fontSize: 14, color: colors.textSecondary, fontWeight: '600' },
  tabTextActive: { color: colors.primary },
  badge: { backgroundColor: colors.primary, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { color: colors.surface, fontSize: 11, fontWeight: '700' },

  searchBox: { padding: 12, paddingBottom: 0 },

  filterRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
    paddingVertical: 10, gap: 8,
  },
  archivedToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginLeft: 'auto' as any,
  },
  archivedLabel: { fontSize: 13, color: colors.textSecondary, fontWeight: '600' },

  list: { padding: 12, gap: 8, paddingBottom: 80 },
  cardName: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, marginBottom: 4 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardSub: { fontSize: 12, color: colors.textSecondary },
  cardDate: { fontSize: 12, color: colors.textMuted, marginLeft: 'auto' as any },
  statusDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.textDisabled },
  statusOpen: { backgroundColor: colors.success },
  statusArchived: { backgroundColor: colors.warning },

  fab: {
    position: 'absolute', bottom: 24, right: 20,
    backgroundColor: colors.primary, borderRadius: 28,
    paddingHorizontal: 22, paddingVertical: 13,
    zIndex: 10,
    shadowColor: colors.brand, shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25, shadowRadius: 8, elevation: 6,
  },
  fabText: { color: colors.surface, fontWeight: '700', fontSize: 15 },
});
