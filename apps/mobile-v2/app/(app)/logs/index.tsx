// Read-only port of apps/mobile/app/(app)/(logs)/index.tsx (751 ln), heavily
// simplified per the Station B4 brief's explicit permission to build "a
// minimal read-only activity list" where the old screen's scope is closer to
// the dropped admin audit-log viewer than a regular per-device surface.
//
// Why simplified, not a straight port: `activity_log`'s manifest sync mode is
// `push-only` (packages/core/src/manifest/tables.ts) — rows are NEVER pulled
// back from the server, so the local SQLite table only ever holds THIS
// device's own writes. The old screen's "My Activity" and "Pending Sync"
// tabs are pure local reads and port cleanly (below). Its "All Activity" and
// "My Team" tabs, however, required a live `GET /logs` server round-trip
// with server-side joins (no local data exists for other users' rows to
// read) plus a SearchablePicker cascade, a map-detail modal (MapDisplay),
// and photo thumbnails (MovePhotoThumb / ActivityLogDetail) — that's the
// dropped-admin-viewer-equivalent complexity the brief calls out, and none
// of the online-API/map/photo infra exists in mobile-v2 yet. Cut here; not
// silently — this screen only ever shows the current device's own activity
// (My Activity + Pending Sync), a real but reduced surface.
//
// ACTION_ICONS/actionLabel come from src/components/ActivityFeed.tsx (single
// source of truth), matching the old screen's own comment convention.
import { useState, useMemo } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, RefreshControl,
} from 'react-native';
import { Stack } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useTheme, useThemedStyles, Card, AppInput, EmptyState } from '@invenpro/ui';
import { useDbQuery, syncNow } from '@invenpro/core';
import {
  getUnsyncedLogs, getLogFiltered, getLogNameMaps, resolveEntityName, type LogEntry,
} from '../../../src/db/queries/log';
import { ACTION_ICONS, actionLabel } from '../../../src/components/ActivityFeed';
import { SearchablePicker, type PickerOption } from '../../../src/components/SearchablePicker';
import { useSession } from '../../../src/hooks/useSession';

type Filter = 'mine' | 'unsynced';

const ENTITY_TYPES = [
  'item', 'equipment_unit', 'job', 'location', 'repair', 'team', 'user', 'role_settings',
];

function relativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return 'yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function LogsScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { user } = useSession();
  const [filter, setFilter] = useState<Filter>('mine');
  const [search, setSearch] = useState('');
  const [filterAction, setFilterAction] = useState<PickerOption | null>(null);
  const [filterEntity, setFilterEntity] = useState<PickerOption | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    // Local rows only — sync still runs so any pending outbox entries push
    // (updating synced_at), even though pulled rows never touch this table.
    try { await syncNow(); } catch { /* offline — local list still reflects reality */ }
    setRefreshing(false);
  };

  const nameMaps = useDbQuery(() => getLogNameMaps(), [], ['users', 'teams', 'jobs', 'locations']);

  const logs = useDbQuery<LogEntry[]>(() => {
    if (!user) return [];
    if (filter === 'unsynced') return getUnsyncedLogs();
    return getLogFiltered({
      userId: user.id,
      action: filterAction?.id,
      entityType: filterEntity?.id,
    }, 100);
  }, [user, filter, filterAction, filterEntity], ['activity_log']);

  const actionOptions = useMemo<PickerOption[]>(
    () => Object.keys(ACTION_ICONS).map(k => ({ id: k, label: actionLabel(k) })),
    [],
  );
  const entityOptions = useMemo<PickerOption[]>(
    () => ENTITY_TYPES.map(e => ({ id: e, label: e.replace(/_/g, ' ') })),
    [],
  );

  const filteredLogs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return logs;
    return logs.filter(l => {
      const names = [
        l.user_name,
        l.team_id ? nameMaps.teams[l.team_id] : null,
        l.job_id ? nameMaps.jobs[l.job_id] : null,
        l.from_location_id ? nameMaps.locations[l.from_location_id] : null,
        l.to_location_id ? nameMaps.locations[l.to_location_id] : null,
        resolveEntityName(nameMaps, l.entity_type, l.entity_id),
        l.note,
      ];
      return names.filter(Boolean).join(' ').toLowerCase().includes(q);
    });
  }, [logs, search, nameMaps]);

  return (
    <>
      <Stack.Screen options={{ title: 'Activity Log', headerShown: true }} />
      <View style={s.container}>
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
            <Text style={[s.chipText, filter === 'unsynced' && s.chipTextActive]}>Pending Sync</Text>
          </TouchableOpacity>
        </View>

        {filter !== 'unsynced' && (
          <View style={s.filterControls}>
            <AppInput
              placeholder="Search note or name…"
              value={search}
              onChangeText={setSearch}
            />
            <SearchablePicker
              placeholder="Filter by action…"
              options={actionOptions}
              value={filterAction}
              onSelect={opt => setFilterAction(prev => (prev?.id === opt.id ? null : opt))}
            />
            <SearchablePicker
              placeholder="Filter by entity type…"
              options={entityOptions}
              value={filterEntity}
              onSelect={opt => setFilterEntity(prev => (prev?.id === opt.id ? null : opt))}
            />
          </View>
        )}

        <FlatList
          data={filteredLogs}
          keyExtractor={l => l.id}
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
              <View style={s.row}>
                <Text style={s.icon}>{ACTION_ICONS[item.action] ?? '·'}</Text>
                <View style={s.middle}>
                  <Text style={s.action}>{actionLabel(item.action)}</Text>
                  {item.user_name ? <Text style={s.user}>{item.user_name}</Text> : null}
                  {item.quantity != null && item.unit ? (
                    <Text style={s.qty}>{item.quantity} {item.unit}</Text>
                  ) : null}
                  {item.note ? <Text style={s.note}>{item.note}</Text> : null}
                  {!item.synced_at && (
                    <Text style={s.pending}>Pending sync</Text>
                  )}
                </View>
                <Text style={s.date}>{relativeDate(item.created_at)}</Text>
              </View>
            </Card>
          )}
          ListEmptyComponent={
            <EmptyState
              title={filter === 'unsynced' ? 'Nothing pending' : 'No activity yet'}
              subtitle={filter === 'unsynced'
                ? 'Every local change has synced.'
                : 'Actions you take will show up here.'}
            />
          }
        />
      </View>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  filterRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 12 },
  chip: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16,
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.border,
  },
  chipActive: { backgroundColor: t.colors.primaryBg, borderColor: t.colors.primary },
  chipText: { fontSize: 13, fontWeight: '600', color: t.colors.textSecondary },
  chipTextActive: { color: t.colors.primary },
  filterControls: { paddingHorizontal: 12, paddingTop: 10, gap: 8 },
  list: { padding: 12, gap: 8, paddingBottom: 48 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  icon: { fontSize: 20, width: 26, textAlign: 'center' },
  middle: { flex: 1, gap: 2 },
  action: { fontSize: 14, fontWeight: '600', color: t.colors.textPrimary, textTransform: 'capitalize' },
  user: { fontSize: 12, color: t.colors.textSecondary },
  qty: { fontSize: 12, color: t.colors.success },
  note: { fontSize: 12, color: t.colors.textSecondary },
  pending: { fontSize: 11, color: t.colors.warning, marginTop: 2 },
  date: { fontSize: 11, color: t.colors.textMuted, paddingTop: 2 },
});
