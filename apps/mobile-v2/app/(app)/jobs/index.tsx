// Ported from apps/mobile/app/(app)/(jobs)/index.tsx (456 ln, was a
// parenthesized group; plain route here per docs/REBUILD-PORTING.md).
//
// Import mapping applied:
//   '../../../src/db/queries/jobs' → '../../../src/repos/jobs'
//   '../../../src/db/queries/equipmentUnits' (getCloseoutBlockers,
//     describeCloseoutBlockers) → '../../../src/repos/equipmentUnits'
//   '../../../src/db/tx' (runInTransaction), '../../../src/hooks/useDbQuery',
//     '../../../src/sync/engine' (syncNow) → '@invenpro/core'
//   '../../../src/lib/themedAlert' (Alert), ui/* components, confirmSheet,
//     useMultiSelect, BulkActionBar → '@invenpro/ui'
//
// Cuts this wave: none — the FAB no longer pushes a separate `(jobs)/create`
// route; it opens JobQuickAdd in a ModalSheet instead (kit rule: grow/reuse,
// one canonical job-creation surface, see JobQuickAdd.tsx's header comment)
// and, on success, navigates straight into the new job's detail screen.
import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, Switch, RefreshControl,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import {
  Alert, useTheme, useThemedStyles, useMultiSelect, BulkActionBar, type BulkAction,
  Card, EmptyState, ModalSheet, SearchHeader, StatusBadge, TypeBadge, FilterChip,
  confirmSheet, Fab,
} from '@invenpro/ui';
import { useDbQuery, runInTransaction, syncNow } from '@invenpro/core';
import {
  getAllJobs, getActiveCheckoutsForUser, updateJobFields, archiveJob, type Job,
} from '../../../src/repos/jobs';
import { getTypeIcon, getTaxonomyTypesWithFallback } from '../../../src/repos/taxonomy';
import { getCloseoutBlockers, describeCloseoutBlockers } from '../../../src/repos/equipmentUnits';
import { appendLog } from '../../../src/db/queries/log';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { SearchablePicker, type PickerOption } from '../../../src/components/SearchablePicker';
import { QuickCreateSheet } from '../../../src/components/quickadd/QuickCreateSheet';
import { TooltipHint } from '../../../src/components/TooltipHint';

interface Checkout {
  log_id: string; entity_id: string; item_name: string;
  unit: string; unit_category: string; quantity: number;
  from_location_id: string | null; job_id: string | null;
  job_name: string | null; created_at: string;
}

type Tab = 'my' | 'all';
type StatusFilter = 'open' | 'closed' | 'all';

export default function JobsScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { user, realUser } = useSession();
  const router = useRouter();
  const canCreate = usePermission('create_jobs');
  const canClose = usePermission('close_jobs');
  const { locked } = useMaintenanceMode();
  const ms = useMultiSelect<Job>();
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('my');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [showArchived, setShowArchived] = useState(false);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    // No explicit local reload needed after this: the pull's own table bumps
    // drive the useDbQuery reads below.
    try { await syncNow(); } catch { /* offline — nothing to sync */ }
    setRefreshing(false);
  }, [refreshing]);

  // Re-runs whenever a local write OR a background sync pull touches one of
  // these tables — no manual reload key needed.
  const myCheckouts = useDbQuery(() => {
    if (!user) return [] as Checkout[];
    return getActiveCheckoutsForUser(user.id) as unknown as Checkout[];
  }, [user], ['activity_log', 'jobs', 'locations', 'inventory_items']);

  const allJobs = useDbQuery((): Job[] => {
    const jobs = getAllJobs(showArchived);
    const byStatus: Job[] = statusFilter === 'all'
      ? jobs
      : jobs.filter(j => j.status === statusFilter);
    if (!search.trim()) return byStatus;
    const q = search.trim().toLowerCase();
    return byStatus.filter(j => j.name.toLowerCase().includes(q));
  }, [search, statusFilter, showArchived], ['jobs']);

  // --- Bulk multi-select ---
  const jobTypes = useDbQuery(() => getTaxonomyTypesWithFallback('job'), [], ['taxonomy_types']);
  const typeOptions = useMemo<PickerOption[]>(
    () => jobTypes.map(jt => ({ id: jt.label, label: jt.label })),
    [jobTypes],
  );

  // Mirror the detail screen's audit log for batch changes (single-row edits in
  // jobs/[id].tsx log job_updated / job_archived) so bulk actions aren't a blind spot.
  const logJob = useCallback((id: string, action: string, note: string) => {
    appendLog({
      action, entity_type: 'job', entity_id: id, job_id: id,
      user_id: realUser?.id ?? null, note,
      team_id: null, from_location_id: null, to_location_id: null,
      quantity: null, unit: null, metadata: null, device_id: null,
    });
  }, [realUser?.id]);

  // Each batch handler iterates the selection and calls the existing per-entity
  // mutation (which self-mirrors its own outbox UPDATE via repos/jobs.ts), then
  // exits selection — exactly like the single-row edits on the detail screen.
  const bulkSetStatus = useCallback((status: 'open' | 'closed') => {
    if (isWriteBlocked()) return;
    const ids = Array.from(ms.selected);
    // Whole batch in one transaction: if any job fails, roll back all of them
    // so the selection is never left half-applied, then tell the user.
    let failedId: string | null = null;
    try {
      runInTransaction(() => {
        for (const id of ids) {
          failedId = id;
          updateJobFields(id, { status });
          logJob(id, 'job_updated', `Status → ${status}`);
        }
      });
    } catch (e) {
      Alert.alert(
        'Could not update jobs',
        `Failed on job ${failedId ?? ''}: ${e instanceof Error ? e.message : 'unknown error'}. No jobs were changed.`,
      );
      return;
    }
    ms.exit();
  }, [ms, logJob]);

  // #212 close-out guard: closing a job with gear still deployed (or open
  // repairs on that gear) strands it — surface the counts and make the user
  // opt in instead of silently closing.
  const doClose = useCallback(async () => {
    const blockers = getCloseoutBlockers(Array.from(ms.selected));
    if (blockers.deployedUnits > 0 || blockers.openRepairs > 0) {
      const ok = await confirmSheet({
        title: 'Close Jobs',
        message: `${describeCloseoutBlockers(blockers)} — close anyway?`,
        confirmLabel: 'Close anyway',
        destructive: true,
      });
      if (!ok) return;
    }
    bulkSetStatus('closed');
  }, [ms, bulkSetStatus]);
  const doReopen = useCallback(() => bulkSetStatus('open'), [bulkSetStatus]);

  const doArchive = useCallback(async () => {
    if (isWriteBlocked()) return;
    const ids = Array.from(ms.selected);
    if (ids.length === 0) return;
    const ok = await confirmSheet({
      title: 'Archive Jobs',
      message: `Archive ${ids.length} job${ids.length === 1 ? '' : 's'}? They will be hidden from active lists.`,
      confirmLabel: 'Archive',
      destructive: true,
    });
    if (!ok) return;
    if (isWriteBlocked()) return;
    // Atomic batch: a mid-loop failure rolls back every archive so the
    // list isn't left partially archived; report which job failed.
    let failedId: string | null = null;
    try {
      runInTransaction(() => {
        for (const id of ids) {
          failedId = id;
          archiveJob(id);
          logJob(id, 'job_archived', 'Bulk archive');
        }
      });
    } catch (e) {
      Alert.alert(
        'Could not archive jobs',
        `Failed on job ${failedId ?? ''}: ${e instanceof Error ? e.message : 'unknown error'}. No jobs were changed.`,
      );
      return;
    }
    ms.exit();
  }, [ms, logJob]);

  const applyType = useCallback((type: string) => {
    setTypePickerOpen(false);
    if (isWriteBlocked()) return;
    const ids = Array.from(ms.selected);
    // One transaction for the whole selection so a failure can't leave only
    // some jobs retyped; surface the offending job and that nothing changed.
    let failedId: string | null = null;
    try {
      runInTransaction(() => {
        for (const id of ids) {
          failedId = id;
          updateJobFields(id, { type });
          logJob(id, 'job_updated', `Type → ${type}`);
        }
      });
    } catch (e) {
      Alert.alert(
        'Could not set type',
        `Failed on job ${failedId ?? ''}: ${e instanceof Error ? e.message : 'unknown error'}. No jobs were changed.`,
      );
      return;
    }
    ms.exit();
  }, [ms, logJob]);

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
                tintColor={t.colors.primary}
                colors={[t.colors.primary]}
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
              <SearchHeader
                value={search}
                onChange={setSearch}
                placeholder="Search jobs..."
                debounceMs={0}
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
                  trackColor={{ false: t.colors.textDisabled, true: t.colors.primaryBg }}
                  thumbColor={showArchived ? t.colors.primary : t.colors.surface}
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
                  tintColor={t.colors.primary}
                  colors={[t.colors.primary]}
                />
              }
              renderItem={({ item: job }) => {
                const typeIcon = job.type ? getTypeIcon('job', job.type) : null;
                const selected = ms.isSelected(job.id);
                return (
                  <TouchableOpacity
                    onPress={() => {
                      if (ms.active) { ms.toggle(job.id); return; }
                      router.push({ pathname: '/(app)/jobs/[id]', params: { id: job.id } });
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
                        <StatusBadge
                          label={job.status}
                          tone={job.status === 'open' ? 'success' : job.status === 'archived' ? 'warning' : 'default'}
                        />
                        {!!job.type && (
                          <TypeBadge type={job.type} icon={typeIcon || undefined} />
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

        {canCreate && !ms.active && (
          <Fab onPress={() => setCreateOpen(true)} label="New Job" />
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

        <QuickCreateSheet
          visible={createOpen}
          kind="job"
          onClose={() => setCreateOpen(false)}
          onCreated={(entity) => {
            router.push({ pathname: '/(app)/jobs/[id]', params: { id: entity.id } });
          }}
        />
      </View>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  tabs: {
    flexDirection: 'row', backgroundColor: t.colors.surface,
    borderBottomWidth: 1, borderBottomColor: t.colors.border,
  },
  tab: {
    flex: 1, paddingVertical: 12, alignItems: 'center',
    flexDirection: 'row', justifyContent: 'center', gap: 6,
  },
  tabActive: { borderBottomWidth: 2, borderBottomColor: t.colors.primary },
  tabText: { fontSize: 14, color: t.colors.textSecondary, fontWeight: '600' },
  tabTextActive: { color: t.colors.primary },
  badge: { backgroundColor: t.colors.primary, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { color: t.colors.surface, fontSize: 11, fontWeight: '700' },

  searchBox: { padding: 12, paddingBottom: 0 },

  filterRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
    paddingVertical: 10, gap: 8,
  },
  archivedToggle: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginLeft: 'auto' as any,
  },
  archivedLabel: { fontSize: 13, color: t.colors.textSecondary, fontWeight: '600' },

  list: { padding: 12, gap: 8, paddingBottom: 96 },
  listSelecting: { paddingBottom: 180 },
  cardSelected: { borderColor: t.colors.primary, backgroundColor: t.colors.primaryBg },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  checkbox: {
    width: 20, height: 20, borderRadius: 6, borderWidth: 2,
    borderColor: t.colors.textDisabled, alignItems: 'center', justifyContent: 'center',
    backgroundColor: t.colors.surface,
  },
  checkboxOn: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
  checkMark: { color: t.colors.surface, fontSize: 13, fontWeight: '800', lineHeight: 16 },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 12 },
  cardName: { fontSize: 15, fontWeight: '600', color: t.colors.textPrimary },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardSub: { fontSize: 12, color: t.colors.textSecondary },
  cardDate: { fontSize: 12, color: t.colors.textMuted, marginLeft: 'auto' as any },
});
