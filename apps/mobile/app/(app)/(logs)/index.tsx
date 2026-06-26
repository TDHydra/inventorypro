import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator,
} from 'react-native';
import { Stack } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import {
  getLogForUser,
  getUnsyncedLogs,
  LogEntry,
} from '../../../src/db/queries/log';
import { getAllActiveUsers } from '../../../src/db/queries/users';
import { ACTION_ICONS, actionLabel } from '../../../src/components/ActivityFeed';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { getValidJwt } from '../../../src/auth/session';

// Local ACTION_ICONS removed — imported from ActivityFeed (single source of truth).

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

/** Shape of rows returned by GET /logs (server-side joins included). */
interface ServerLogRow {
  id: string;
  action: string;
  user_name: string | null;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  created_at: string;
}

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

  // Server-fetch state for the All-Activity tab
  const [serverLogs, setServerLogs] = useState<ServerLogRow[]>([]);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

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

  // Computed date values — partial strings (<10 chars) are treated as unset
  const sinceVal = filterSince.trim().length >= 10 ? filterSince.trim() : undefined;
  // Append end-of-day time so the until date is inclusive
  const untilVal =
    filterUntil.trim().length >= 10
      ? filterUntil.trim() + 'T23:59:59.999Z'
      : undefined;

  // Local logs for My Activity and Pending Sync tabs (offline-first, unchanged)
  const logs = useMemo<LogEntry[]>(() => {
    if (!user) return [];
    if (filter === 'unsynced') return getUnsyncedLogs();
    // Default: 'mine' — filter === 'all' is handled by the server fetch below
    return getLogForUser(user.id, 50);
  }, [user, filter]);

  // Server fetch for the All-Activity tab — re-runs whenever tab or filters change
  useEffect(() => {
    if (filter !== 'all') return;

    let cancelled = false;
    setServerLoading(true);
    setServerError(null);
    setServerLogs([]);

    void (async () => {
      try {
        const jwt = await getValidJwt();
        if (!jwt) {
          if (!cancelled) {
            setServerError('Connect to the server to view team activity.');
            setServerLoading(false);
          }
          return;
        }

        const params = new URLSearchParams({ limit: '200' });
        if (filterUser?.id) params.set('user_id', filterUser.id);
        if (filterAction?.id) params.set('action', filterAction.id);
        if (sinceVal) params.set('after', `${sinceVal}T00:00:00.000Z`);
        if (untilVal) params.set('before', untilVal);

        const res = await fetch(`${API_BASE}/logs?${params}`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });

        if (!res.ok) {
          if (!cancelled) {
            setServerError('Connect to the server to view team activity.');
            setServerLoading(false);
          }
          return;
        }

        const data = await res.json() as { logs: ServerLogRow[] };
        if (!cancelled) {
          setServerLogs(data.logs);
          setServerLoading(false);
        }
      } catch (err) {
        void err;
        if (!cancelled) {
          setServerError('Connect to the server to view team activity.');
          setServerLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [filter, filterUser, filterAction, sinceVal, untilVal]);

  function clearAllFilters() {
    setFilterUser(null);
    setFilterAction(null);
    setFilterSince('');
    setFilterUntil('');
  }

  // Derive from computed date values so partial date strings don't show the button
  const anyFilterSet = !!(filterUser || filterAction || sinceVal || untilVal);

  // Fall back to 'mine' if admin permission is revoked mid-session
  useEffect(() => {
    if (!canViewAll && filter === 'all') setFilter('mine');
  }, [canViewAll, filter]);

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
        {filter === 'all' ? (
          serverLoading ? (
            <View style={s.empty}>
              <ActivityIndicator size="large" color="#2563EB" />
            </View>
          ) : serverError ? (
            <View style={s.empty}>
              <Text style={s.emptyText}>{serverError}</Text>
            </View>
          ) : (
            <FlatList<ServerLogRow>
              data={serverLogs}
              keyExtractor={l => l.id}
              contentContainerStyle={s.list}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item: log }) => (
                <View style={s.row}>
                  <Text style={s.icon}>{ACTION_ICONS[log.action] ?? '·'}</Text>
                  <View style={s.middle}>
                    <Text style={s.action}>{actionLabel(log.action)}</Text>
                    {log.user_name ? <Text style={s.user}>{log.user_name}</Text> : null}
                    {log.quantity != null && log.unit && (
                      <Text style={s.qty}>
                        {log.quantity} {log.unit}
                      </Text>
                    )}
                    {log.note ? <Text style={s.note}>{log.note}</Text> : null}
                  </View>
                  <View style={s.right}>
                    <Text style={s.date}>{new Date(log.created_at).toLocaleDateString()}</Text>
                  </View>
                </View>
              )}
              ListEmptyComponent={
                <View style={s.empty}>
                  <Text style={s.emptyText}>No activity</Text>
                </View>
              }
            />
          )
        ) : (
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
        )}
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
