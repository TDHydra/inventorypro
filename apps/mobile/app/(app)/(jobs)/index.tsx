import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Switch, RefreshControl, Alert,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { useMultiSelect } from '../../../src/hooks/useMultiSelect';
import {
  getAllJobs, getActiveCheckoutsForUser, updateJobFields, archiveJob, Job,
} from '../../../src/db/queries/jobs';
import { getTypeIcon, getTaxonomyTypes } from '../../../src/db/queries/taxonomy';
import { appendLog } from '../../../src/db/queries/log';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { rowsAs } from '../../../src/db/schema';
import { colors } from '../../../src/theme';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { Card } from '../../../src/components/ui/Card';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { AppInput } from '../../../src/components/ui/AppInput';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { BulkActionBar, BulkAction } from '../../../src/components/BulkActionBar';
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
  const canClose = usePermission('close_jobs');
  const { locked } = useMaintenanceMode();
  const ms = useMultiSelect<Job>();
  const [typePickerOpen, setTypePickerOpen] = useState(false);
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

  // --- Bulk multi-select ---
  const jobTypes = useMemo(() => getTaxonomyTypes('job'), []);
  const typeOptions = useMemo<PickerOption[]>(
    () => jobTypes.map(t => ({ id: t.label, label: t.label })),
    [jobTypes],
  );

  // Mirror the detail screen's audit log for batch changes (single-row edits in
  // [id].tsx log job_updated / job_archived) so bulk actions aren't a blind spot.
  const logJob = useCallback((id: string, action: string, note: string) => {
    appendLog({
      action, entity_type: 'job', entity_id: id, job_id: id,
      user_id: user?.id ?? null, note,
      team_id: null, from_location_id: null, to_location_id: null,
      quantity: null, unit: null, metadata: null, device_id: null,
    });
  }, [user?.id]);

  // Each batch handler iterates the selection and calls the existing per-entity
  // mutation (which queues its own outbox UPDATE), then refreshes + exits — exactly
  // like the single-row edits on the detail screen.
  const bulkSetStatus = useCallback((status: 'open' | 'closed') => {
    if (isWriteBlocked()) return;
    for (const id of Array.from(ms.selected)) {
      updateJobFields(id, { status });
      logJob(id, 'job_updated', `Status → ${status}`);
    }
    reloadLocalData();
    ms.exit();
  }, [ms, reloadLocalData, logJob]);

  const doClose = useCallback(() => bulkSetStatus('closed'), [bulkSetStatus]);
  const doReopen = useCallback(() => bulkSetStatus('open'), [bulkSetStatus]);

  const doArchive = useCallback(() => {
    if (isWriteBlocked()) return;
    const ids = Array.from(ms.selected);
    if (ids.length === 0) return;
    Alert.alert(
      'Archive Jobs',
      `Archive ${ids.length} job${ids.length === 1 ? '' : 's'}? They will be hidden from active lists.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive', style: 'destructive',
          onPress: () => {
            if (isWriteBlocked()) return;
            for (const id of ids) {
              archiveJob(id);
              logJob(id, 'job_archived', 'Bulk archive');
            }
            reloadLocalData();
            ms.exit();
          },
        },
      ],
    );
  }, [ms, reloadLocalData, logJob]);

  const applyType = useCallback((type: string) => {
    setTypePickerOpen(false);
    if (isWriteBlocked()) return;
    for (const id of Array.from(ms.selected)) {
      updateJobFields(id, { type });
      logJob(id, 'job_updated', `Type → ${type}`);
    }
    reloadLocalData();
    ms.exit();
  }, [ms, reloadLocalData, logJob]);

  const bulkActions = useMemo<BulkAction[]>(() => {
    const a: BulkAction[] = [];
    if (canClose) a.push({ key: 'close', label: 'Close', onPress: doClose });
    if (canCreate) a.push({ key: 'archive', label: 'Archive', destructive: true, onPress: doArchive });
    if (canCreate) a.push({ key: 'reopen', label: 'Reopen', onPress: doReopen });
    if (canCreate && typeOptions.length > 0) {
      a.push({ key: 'type', label: 'Set type', onPress: () => setTypePickerOpen(true) });
    }
    return a;
  }, [canClose, canCreate, typeOptions.length, doClose, doArchive, doReopen]);

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
            onPress={() => { ms.exit(); setTab('my'); }}
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
              contentContainerStyle={[s.list, ms.active && s.listSelecting]}
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  tintColor={colors.primary}
                  colors={[colors.primary]}
                />
              }
              renderItem={({ item: job }) => {
                const typeIcon = job.type ? getTypeIcon('job', job.type) : null;
                const selected = ms.isSelected(job.id);
                return (
                  <TouchableOpacity
                    onPress={() => {
                      if (ms.active) { ms.toggle(job.id); return; }
                      router.push({ pathname: '/(app)/(jobs)/[id]', params: { id: job.id } });
                    }}
                    onLongPress={() => {
                      if (canCreate || canClose) ms.enter(job.id);
                    }}
                    delayLongPress={300}
                  >
                    <Card variant="list" style={selected ? s.cardSelected : undefined}>
                      <View style={s.nameRow}>
                        {ms.active && (
                          <View style={[s.checkbox, selected && s.checkboxOn]}>
                            {selected && <Text style={s.checkMark}>✓</Text>}
                          </View>
                        )}
                        <Text style={s.cardName}>{job.name}</Text>
                      </View>
                      <View style={s.cardRow}>
                        <View style={[
                          s.statusDot,
                          job.status === 'open' ? s.statusOpen
                            : job.status === 'archived' ? s.statusArchived
                            : undefined,
                        ]} />
                        <Text style={s.cardSub}>{job.status}</Text>
                        {!!job.type && (
                          <Text style={s.cardSub}>
                            · {typeIcon ? `${typeIcon} ${job.type}` : job.type}
                          </Text>
                        )}
                        <Text style={s.cardDate}>
                          {new Date(job.created_at).toLocaleDateString()}
                        </Text>
                      </View>
                    </Card>
                  </TouchableOpacity>
                );
              }}
              ListEmptyComponent={<EmptyState title="No jobs found" />}
            />
          </>
        )}

        {tab === 'all' && ms.active && bulkActions.length > 0 && (
          <BulkActionBar
            count={ms.count}
            actions={bulkActions}
            onSelectAll={() => ms.selectAll(allJobs.map(j => j.id))}
            onCancel={ms.exit}
            disabled={locked}
          />
        )}

        <ModalSheet visible={typePickerOpen} onClose={() => setTypePickerOpen(false)}>
          <Text style={s.sheetTitle}>Set job type</Text>
          <SearchablePicker
            placeholder="Search types..."
            options={typeOptions}
            value={null}
            onSelect={(opt) => applyType(opt.id)}
          />
        </ModalSheet>
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
  listSelecting: { paddingBottom: 180 },
  cardSelected: { borderColor: colors.primary, backgroundColor: colors.primaryBg },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  checkbox: {
    width: 20, height: 20, borderRadius: 6, borderWidth: 2,
    borderColor: colors.textDisabled, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkMark: { color: colors.surface, fontSize: 13, fontWeight: '800', lineHeight: 16 },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginBottom: 12 },
  cardName: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
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
