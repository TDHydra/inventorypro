import { useState, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput } from 'react-native';
import { Stack } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import {
  getLogForUser,
  getUnsyncedLogs,
  getRecentLog,
  getLogFiltered,
  LogEntry,
} from '../../../src/db/queries/log';
import { getAllActiveUsers } from '../../../src/db/queries/users';
import { ACTION_ICONS, actionLabel } from '../../../src/components/ActivityFeed';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';

// Local ACTION_ICONS removed — imported from ActivityFeed (single source of truth).

type Filter = 'mine' | 'unsynced' | 'all';

export default function LogsScreen() {
  const { user } = useSession();
  const canViewAll = usePermission('view_all_logs');
  const [filter, setFilter] = useState<Filter>('mine');

  // All-Activity filter state
  const [filterUser, setFilterUser] = useState<PickerOption | null>(null);
  const [filterAction, setFilterAction] = useState<PickerOption | null>(null);
  const [filterSince, setFilterSince] = useState('');
  const [filterUntil, setFilterUntil] = useState('');

  // User options for the user picker (only loaded when admin can see all activity)
  const userOptions = useMemo<PickerOption[]>(() => {
    if (!canViewAll) return [];
    return getAllActiveUsers().map(u => ({ id: u.id, label: u.name }));
  }, [canViewAll]);

  // Action options derived from the shared ACTION_ICONS map
  const actionOptions = useMemo<PickerOption[]>(
    () => Object.keys(ACTION_ICONS).map(k => ({ id: k, label: actionLabel(k) })),
    [],
  );

  const logs = useMemo<LogEntry[]>(() => {
    if (!user) return [];

    if (filter === 'unsynced') {
      return getUnsyncedLogs();
    }

    if (filter === 'all') {
      const sinceVal = filterSince.trim().length >= 10 ? filterSince.trim() : undefined;
      // Append end-of-day time so the until date is inclusive
      const untilVal =
        filterUntil.trim().length >= 10
          ? filterUntil.trim() + 'T23:59:59.999Z'
          : undefined;
      const hasFilter = filterUser || filterAction || sinceVal || untilVal;
      if (!hasFilter) return getRecentLog(100);
      return getLogFiltered(
        {
          userId: filterUser?.id,
          action: filterAction?.id,
          sinceISO: sinceVal,
          untilISO: untilVal,
        },
        200,
      );
    }

    // Default: 'mine'
    return getLogForUser(user.id, 50);
  }, [user, filter, filterUser, filterAction, filterSince, filterUntil]);

  function clearAllFilters() {
    setFilterUser(null);
    setFilterAction(null);
    setFilterSince('');
    setFilterUntil('');
  }

  const anyFilterSet = !!(filterUser || filterAction || filterSince || filterUntil);

  return (
    <>
      <Stack.Screen options={{ title: 'Activity Log', headerShown: true }} />
      <View style={s.container}>
        {/* ── Filter chips ──────────────────────────────────────────── */}
        <View style={s.filterRow}>
          <TouchableOpacity
            style={[s.chip, filter === 'mine' && s.chipActive]}
            onPress={() => setFilter('mine')}
          >
            <Text style={[s.chipText, filter === 'mine' && s.chipTextActive]}>My Activity</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.chip, filter === 'unsynced' && s.chipActive]}
            onPress={() => setFilter('unsynced')}
          >
            <Text style={[s.chipText, filter === 'unsynced' && s.chipTextActive]}>
              Pending Sync
            </Text>
          </TouchableOpacity>
          {canViewAll && (
            <TouchableOpacity
              style={[s.chip, filter === 'all' && s.chipActive]}
              onPress={() => setFilter('all')}
            >
              <Text style={[s.chipText, filter === 'all' && s.chipTextActive]}>All Activity</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ── All-Activity filter controls (admin only) ─────────────── */}
        {filter === 'all' && (
          <View style={s.filterControls}>
            <SearchablePicker
              placeholder="Filter by user…"
              options={userOptions}
              value={filterUser}
              onSelect={opt =>
                setFilterUser(prev => (prev?.id === opt.id ? null : opt))
              }
            />
            <View style={s.gap} />
            <SearchablePicker
              placeholder="Filter by action…"
              options={actionOptions}
              value={filterAction}
              onSelect={opt =>
                setFilterAction(prev => (prev?.id === opt.id ? null : opt))
              }
            />
            <View style={s.dateRow}>
              <TextInput
                style={[s.dateInput, s.flex1]}
                placeholder="From YYYY-MM-DD"
                placeholderTextColor="#94A3B8"
                value={filterSince}
                onChangeText={setFilterSince}
                keyboardType="numbers-and-punctuation"
                maxLength={10}
              />
              <TextInput
                style={[s.dateInput, s.flex1]}
                placeholder="To YYYY-MM-DD"
                placeholderTextColor="#94A3B8"
                value={filterUntil}
                onChangeText={setFilterUntil}
                keyboardType="numbers-and-punctuation"
                maxLength={10}
              />
            </View>
            {anyFilterSet && (
              <TouchableOpacity style={s.clearBtn} onPress={clearAllFilters}>
                <Text style={s.clearBtnText}>Clear filters</Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* ── Log list ──────────────────────────────────────────────── */}
        <FlatList<LogEntry>
          data={logs}
          keyExtractor={l => l.id}
          contentContainerStyle={s.list}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item: log }) => (
            <View style={s.row}>
              <Text style={s.icon}>{ACTION_ICONS[log.action] ?? '·'}</Text>
              <View style={s.middle}>
                <Text style={s.action}>{actionLabel(log.action)}</Text>
                {/* Show user_name in All-Activity view so cross-user events are legible */}
                {filter === 'all' && log.user_name ? (
                  <Text style={s.user}>{log.user_name}</Text>
                ) : null}
                {log.quantity != null && log.unit && (
                  <Text style={s.qty}>
                    {log.quantity} {log.unit}
                  </Text>
                )}
                {log.note ? <Text style={s.note}>{log.note}</Text> : null}
              </View>
              <View style={s.right}>
                <Text style={s.date}>{new Date(log.created_at).toLocaleDateString()}</Text>
                {!log.synced_at && <Text style={s.pending}>↑ pending</Text>}
              </View>
            </View>
          )}
          ListEmptyComponent={
            <View style={s.empty}>
              <Text style={s.emptyText}>No log entries</Text>
            </View>
          }
        />
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF' },
  filterRow: { flexDirection: 'row', gap: 8, padding: 12, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: '#F1F5F9',
    borderRadius: 20,
  },
  chipActive: { backgroundColor: '#DBEAFE' },
  chipText: { fontSize: 13, color: '#64748B' },
  chipTextActive: { color: '#1D4ED8', fontWeight: '600' },

  // All-Activity filter panel
  filterControls: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 8,
  },
  gap: { height: 0 }, // structural spacer used between SearchablePicker instances
  dateRow: { flexDirection: 'row', gap: 8 },
  dateInput: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    paddingHorizontal: 12,
    height: 44,
    fontSize: 13,
    color: '#1E293B',
  },
  flex1: { flex: 1 },
  clearBtn: { alignSelf: 'flex-end', paddingVertical: 4 },
  clearBtnText: { fontSize: 13, color: '#2563EB', fontWeight: '600' },

  // Log rows
  list: { padding: 12, gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    backgroundColor: '#fff',
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  icon: { fontSize: 20, width: 28, textAlign: 'center' },
  middle: { flex: 1 },
  action: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1E293B',
    textTransform: 'capitalize',
  },
  user: { fontSize: 12, color: '#64748B', marginTop: 2 },
  qty: { fontSize: 12, color: '#16A34A', marginTop: 2 },
  note: { fontSize: 12, color: '#64748B', marginTop: 2 },
  right: { alignItems: 'flex-end', gap: 4 },
  date: { fontSize: 11, color: '#94A3B8' },
  pending: { fontSize: 10, color: '#F59E0B', fontWeight: '600' },
  empty: { alignItems: 'center', paddingTop: 40 },
  emptyText: { fontSize: 14, color: '#94A3B8' },
});
