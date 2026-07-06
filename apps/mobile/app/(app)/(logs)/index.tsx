import { useState, useMemo, useEffect, useCallback } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator,
  RefreshControl, Modal,
} from 'react-native';
import { Stack } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import {
  getUnsyncedLogs,
  getLogFiltered,
  getLogNameMaps,
  resolveEntityName,
  LogEntry,
  LogNameMaps,
} from '../../../src/db/queries/log';
import { getAllActiveUsers, getAllUsers, roleColor, getRoleColorMap } from '../../../src/db/queries/users';
import { getAllTeams } from '../../../src/db/queries/teams';
import { ACTION_ICONS, actionLabel } from '../../../src/components/ActivityFeed';
import { ActivityLogDetail } from '../../../src/components/ActivityLogDetail';
import { MovePhotoThumb } from '../../../src/components/MovePhotoThumb';
import { MapDisplay } from '../../../src/components/MapDisplay';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { getValidJwt } from '../../../src/auth/session';
import { syncNow } from '../../../src/sync/engine';
import { TooltipHint } from '../../../src/components/TooltipHint';
import { ErrorView } from '../../../src/components/ui/ErrorView';
import { useDataVersion } from '../../../src/hooks/useDataVersion';
import { colors, radii } from '../../../src/theme';

// Local ACTION_ICONS removed — imported from ActivityFeed (single source of truth).

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

/**
 * Shape of rows returned by GET /logs (server-side joins included).
 * The API selects `al.*`, so move-stamped coordinates ride along even though
 * most columns aren't otherwise surfaced in this screen — declared here so
 * the map affordance below can read them.
 */
interface ServerLogRow {
  id: string;
  action: string;
  user_name: string | null;
  quantity: number | null;
  unit: string | null;
  note: string | null;
  created_at: string;
  latitude?: number | null;
  longitude?: number | null;
  location_accuracy?: number | null;
}

type Filter = 'mine' | 'unsynced' | 'all' | 'my_teams';

// entity_type values the app stamps onto activity_log rows — drives the
// entity-type filter picker on the local tabs.
const ENTITY_TYPES = [
  'item', 'equipment_unit', 'job', 'location', 'repair', 'team', 'user', 'role_settings',
];

/** Data needed to render the map-detail modal, gathered from either the local
 * (LogEntry) or server (ServerLogRow) row shape. */
interface MapModalData {
  latitude: number;
  longitude: number;
  location_accuracy: number | null;
  action: string;
  note: string | null;
  quantity: number | null;
  unit: string | null;
  created_at: string;
  user_name?: string | null;
}

/** Adapt a server log row into the LogEntry shape ActivityLogDetail expects.
 * Server rows only surface a subset of columns, so the rest are nulled — the
 * detail view hides fields it can't resolve. */
function serverRowToLog(r: ServerLogRow): LogEntry {
  return {
    id: r.id,
    user_id: null,
    team_id: null,
    action: r.action,
    entity_type: '',
    entity_id: null,
    from_location_id: null,
    to_location_id: null,
    quantity: r.quantity,
    unit: r.unit,
    job_id: null,
    note: r.note,
    metadata: null,
    device_id: null,
    created_at: r.created_at,
    synced_at: null,
    latitude: r.latitude ?? null,
    longitude: r.longitude ?? null,
    location_accuracy: r.location_accuracy ?? null,
    user_name: r.user_name,
  };
}

export default function LogsScreen() {
  const { user } = useSession();
  const canViewAll = usePermission('view_all_logs');
  const canViewTeam = usePermission('view_team_activity');
  const [filter, setFilter] = useState<Filter>('mine');
  const dataVersion = useDataVersion();

  // Both the All-Activity and My-Team tabs fetch from the server (/logs).
  const serverMode = filter === 'all' || filter === 'my_teams';

  // Filter state (shared across tabs; some controls only render where meaningful)
  const [filterUser, setFilterUser] = useState<PickerOption | null>(null);
  const [filterAction, setFilterAction] = useState<PickerOption | null>(null);
  const [filterEntity, setFilterEntity] = useState<PickerOption | null>(null);
  const [filterTeam, setFilterTeam] = useState<PickerOption | null>(null);
  const [filterSince, setFilterSince] = useState('');
  const [filterUntil, setFilterUntil] = useState('');
  const [search, setSearch] = useState('');

  // Expanded row ids (tap a row to reveal the what-changed detail)
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = useCallback((id: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // id → name maps, loaded once per data version, for resolving row references
  // (actor / team / job / from→to location / entity) without per-row DB queries.
  const nameMaps = useMemo<LogNameMaps>(() => getLogNameMaps(), [dataVersion]);

  // Server-fetch state for the All-Activity tab
  const [serverLogs, setServerLogs] = useState<ServerLogRow[]>([]);
  const [serverLoading, setServerLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Refetch key — increment to re-trigger the server fetch useEffect
  const [refetchKey, setRefetchKey] = useState(0);
  const refetch = useCallback(() => setRefetchKey(k => k + 1), []);

  // Log-detail map modal — set when a row with stamped coordinates is tapped
  const [mapLog, setMapLog] = useState<MapModalData | null>(null);

  // Pull-to-refresh state for the All-Activity list
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — refetch still runs */ }
    refetch();
    setRefreshing(false);
  }, [refreshing, refetch]);

  // User options for the user picker (only loaded when admin can see all activity)
  const userOptions = useMemo<PickerOption[]>(() => {
    if (!canViewAll) return [];
    return getAllActiveUsers().map(u => ({ id: u.id, label: u.name }));
  }, [canViewAll]);

  const roleColors = useMemo(() => getRoleColorMap(), []);
  // Map user name → role for tinting actor names in server-fetched log rows
  // (ServerLogRow carries user_name but not user_id; getAllUsers includes inactive
  // users who may appear in historical log entries).
  const userRoleByName = useMemo(
    () => Object.fromEntries(getAllUsers().map(u => [u.name, u.role])),
    [],
  );

  // Action options derived from the shared ACTION_ICONS map
  const actionOptions = useMemo<PickerOption[]>(
    () => Object.keys(ACTION_ICONS).map(k => ({ id: k, label: actionLabel(k) })),
    [],
  );

  // Entity-type options — the set of entity_type values the app writes to logs.
  const entityOptions = useMemo<PickerOption[]>(
    () => ENTITY_TYPES.map(e => ({ id: e, label: e.replace(/_/g, ' ') })),
    [],
  );

  // Team options for the team filter (local tabs)
  const teamOptions = useMemo<PickerOption[]>(
    () => getAllTeams().map(t => ({ id: t.id, label: t.name })),
    [dataVersion],
  );

  // Computed date values — partial strings (<10 chars) are treated as unset
  const sinceVal = filterSince.trim().length >= 10 ? filterSince.trim() : undefined;
  // Append end-of-day time so the until date is inclusive
  const untilVal =
    filterUntil.trim().length >= 10
      ? filterUntil.trim() + 'T23:59:59.999Z'
      : undefined;

  // Local logs for My Activity and Pending Sync tabs (offline-first). dataVersion
  // is included so this list refreshes after a background sync pull applies
  // changes, without a manual pull-to-refresh. The My-Activity tab is always
  // scoped to the current user (view_own_logs gating) and applies the SQL-side
  // filters; free-text search is layered in-memory below so it can also match
  // resolved names (actor/team/job/location) — not just the note column.
  const logs = useMemo<LogEntry[]>(() => {
    if (!user) return [];
    if (filter === 'unsynced') return getUnsyncedLogs();
    // Default: 'mine' — filter === 'all' / 'my_teams' handled by the server fetch
    return getLogFiltered({
      userId: user.id,
      action: filterAction?.id,
      entityType: filterEntity?.id,
      teamId: filterTeam?.id,
      sinceISO: sinceVal ? `${sinceVal}T00:00:00.000Z` : undefined,
      untilISO: untilVal,
    }, 100);
  }, [user, filter, dataVersion, filterAction, filterEntity, filterTeam, sinceVal, untilVal]);

  // In-memory text search for the local list — matches the note plus every
  // resolved name so "smith" finds rows by actor/team/job/location too.
  const localLogs = useMemo<LogEntry[]>(() => {
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

  // In-memory text search for the server list (rows carry note + user_name only).
  const filteredServerLogs = useMemo<ServerLogRow[]>(() => {
    const q = search.trim().toLowerCase();
    if (!q) return serverLogs;
    return serverLogs.filter(l =>
      [l.note, l.user_name].filter(Boolean).join(' ').toLowerCase().includes(q),
    );
  }, [serverLogs, search]);

  // Server fetch for the All-Activity / My-Team tabs — re-runs whenever tab,
  // filters, or refetchKey change
  useEffect(() => {
    if (!serverMode) return;

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
        if (filter === 'my_teams') params.set('scope', 'my_teams');
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
        if (__DEV__) console.warn('[logs] all-activity fetch failed', err);
        if (!cancelled) {
          setServerError('Connect to the server to view team activity.');
          setServerLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [filter, serverMode, filterUser, filterAction, sinceVal, untilVal, refetchKey]);

  function clearAllFilters() {
    setFilterUser(null);
    setFilterAction(null);
    setFilterEntity(null);
    setFilterTeam(null);
    setFilterSince('');
    setFilterUntil('');
    setSearch('');
  }

  // Derive from computed date values so partial date strings don't show the button
  const anyFilterSet = !!(
    filterUser || filterAction || filterEntity || filterTeam ||
    sinceVal || untilVal || search.trim()
  );

  // Fall back to 'mine' if the backing permission is revoked mid-session
  useEffect(() => {
    if (!canViewAll && filter === 'all') setFilter('mine');
    if (!canViewTeam && !canViewAll && filter === 'my_teams') setFilter('mine');
  }, [canViewAll, canViewTeam, filter]);

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
          {(canViewTeam || canViewAll) && (
            <TouchableOpacity
              style={[s.chip, filter === 'my_teams' && s.chipActive]}
              onPress={() => setFilter('my_teams')}
            >
              <Text style={[s.chipText, filter === 'my_teams' && s.chipTextActive]}>My Team</Text>
            </TouchableOpacity>
          )}
          {canViewAll && (
            <TouchableOpacity
              style={[s.chip, filter === 'all' && s.chipActive]}
              onPress={() => setFilter('all')}
            >
              <Text style={[s.chipText, filter === 'all' && s.chipTextActive]}>All Activity</Text>
            </TouchableOpacity>
          )}
        </View>

        <TooltipHint screenKey="logs" />

        {/* ── Filter controls ───────────────────────────────────────── */}
        {/* Shown on every tab except the tiny Pending-Sync list. The user
            picker only makes sense on the server tabs (the My-Activity tab is
            already scoped to you); entity/team filters only apply to the local
            list (server rows don't carry those columns). */}
        {filter !== 'unsynced' && (
          <View style={s.filterControls}>
            <TextInput
              style={s.searchInput}
              placeholder="Search note or name…"
              placeholderTextColor={colors.textMuted}
              value={search}
              onChangeText={setSearch}
              autoCapitalize="none"
              returnKeyType="search"
            />
            {serverMode && (
              <SearchablePicker
                placeholder="Filter by user…"
                options={userOptions}
                value={filterUser}
                onSelect={opt =>
                  setFilterUser(prev => (prev?.id === opt.id ? null : opt))
                }
              />
            )}
            <SearchablePicker
              placeholder="Filter by action…"
              options={actionOptions}
              value={filterAction}
              onSelect={opt =>
                setFilterAction(prev => (prev?.id === opt.id ? null : opt))
              }
            />
            {!serverMode && (
              <>
                <SearchablePicker
                  placeholder="Filter by entity type…"
                  options={entityOptions}
                  value={filterEntity}
                  onSelect={opt =>
                    setFilterEntity(prev => (prev?.id === opt.id ? null : opt))
                  }
                />
                <SearchablePicker
                  placeholder="Filter by team…"
                  options={teamOptions}
                  value={filterTeam}
                  onSelect={opt =>
                    setFilterTeam(prev => (prev?.id === opt.id ? null : opt))
                  }
                />
              </>
            )}
            <View style={s.dateRow}>
              <TextInput
                style={[s.dateInput, s.flex1]}
                placeholder="From YYYY-MM-DD"
                placeholderTextColor={colors.textMuted}
                value={filterSince}
                onChangeText={setFilterSince}
                keyboardType="numbers-and-punctuation"
                maxLength={10}
              />
              <TextInput
                style={[s.dateInput, s.flex1]}
                placeholder="To YYYY-MM-DD"
                placeholderTextColor={colors.textMuted}
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
        {serverMode ? (
          serverLoading ? (
            <View style={s.empty}>
              <ActivityIndicator size="large" color={colors.primary} />
            </View>
          ) : serverError ? (
            <View style={s.empty}>
              <ErrorView message={serverError} onRetry={refetch} />
            </View>
          ) : (
            <FlatList<ServerLogRow>
              data={filteredServerLogs}
              keyExtractor={l => l.id}
              contentContainerStyle={s.list}
              keyboardShouldPersistTaps="handled"
              refreshControl={
                <RefreshControl
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  tintColor={colors.primary}
                  colors={[colors.primary]}
                />
              }
              renderItem={({ item: log }) => {
                const isOpen = expanded.has(log.id);
                const hasCoords = log.latitude != null && log.longitude != null;
                return (
                  <View style={s.card}>
                    <TouchableOpacity
                      style={s.row}
                      onPress={() => toggleExpanded(log.id)}
                      activeOpacity={0.7}
                    >
                      <Text style={s.icon}>{ACTION_ICONS[log.action] ?? '·'}</Text>
                      <View style={s.middle}>
                        <Text style={s.action}>{actionLabel(log.action)}</Text>
                        {log.user_name ? <Text style={[s.user, { color: roleColor(userRoleByName[log.user_name] ?? '', roleColors) }]}>{log.user_name}</Text> : null}
                        {log.quantity != null && log.unit && (
                          <Text style={s.qty}>
                            {log.quantity} {log.unit}
                          </Text>
                        )}
                        {log.note ? <Text style={s.note} numberOfLines={isOpen ? undefined : 1}>{log.note}</Text> : null}
                      </View>
                      <View style={s.right}>
                        <Text style={s.date}>{new Date(log.created_at).toLocaleDateString()}</Text>
                        <Text style={s.chevron}>{isOpen ? '▲' : '▼'}</Text>
                      </View>
                      <MovePhotoThumb logId={log.id} />
                    </TouchableOpacity>
                    {isOpen && (
                      <ActivityLogDetail
                        log={serverRowToLog(log)}
                        nameMaps={nameMaps}
                        onViewMap={hasCoords ? () => setMapLog({
                          latitude: log.latitude!,
                          longitude: log.longitude!,
                          location_accuracy: log.location_accuracy ?? null,
                          action: log.action,
                          note: log.note,
                          quantity: log.quantity,
                          unit: log.unit,
                          created_at: log.created_at,
                          user_name: log.user_name,
                        }) : undefined}
                      />
                    )}
                  </View>
                );
              }}
              ListEmptyComponent={
                <View style={s.empty}>
                  <Text style={s.emptyText}>No activity</Text>
                </View>
              }
            />
          )
        ) : (
          <FlatList<LogEntry>
            data={filter === 'unsynced' ? logs : localLogs}
            keyExtractor={l => l.id}
            contentContainerStyle={s.list}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item: log }) => {
              const isOpen = expanded.has(log.id);
              const hasCoords = log.latitude != null && log.longitude != null;
              // Compact context line on the collapsed row: the most specific
              // resolved reference (entity → job → destination location).
              const subtitle =
                resolveEntityName(nameMaps, log.entity_type, log.entity_id) ??
                (log.job_id ? nameMaps.jobs[log.job_id] : null) ??
                (log.to_location_id ? nameMaps.locations[log.to_location_id] : null);
              return (
                <View style={s.card}>
                  <TouchableOpacity
                    style={s.row}
                    onPress={() => toggleExpanded(log.id)}
                    activeOpacity={0.7}
                  >
                    <Text style={s.icon}>{ACTION_ICONS[log.action] ?? '·'}</Text>
                    <View style={s.middle}>
                      <Text style={s.action}>{actionLabel(log.action)}</Text>
                      {log.user_name ? (
                        <Text style={[s.user, { color: roleColor(userRoleByName[log.user_name] ?? '', roleColors) }]}>
                          {log.user_name}
                        </Text>
                      ) : null}
                      {subtitle ? <Text style={s.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
                      {log.quantity != null && log.unit && (
                        <Text style={s.qty}>
                          {log.quantity} {log.unit}
                        </Text>
                      )}
                      {log.note ? <Text style={s.note} numberOfLines={isOpen ? undefined : 1}>{log.note}</Text> : null}
                    </View>
                    <View style={s.right}>
                      <Text style={s.date}>{new Date(log.created_at).toLocaleDateString()}</Text>
                      {!log.synced_at && <Text style={s.pending}>↑ pending</Text>}
                      <Text style={s.chevron}>{isOpen ? '▲' : '▼'}</Text>
                    </View>
                    <MovePhotoThumb logId={log.id} />
                  </TouchableOpacity>
                  {isOpen && (
                    <ActivityLogDetail
                      log={log}
                      nameMaps={nameMaps}
                      onViewMap={hasCoords ? () => setMapLog({
                        latitude: log.latitude!,
                        longitude: log.longitude!,
                        location_accuracy: log.location_accuracy,
                        action: log.action,
                        note: log.note,
                        quantity: log.quantity,
                        unit: log.unit,
                        created_at: log.created_at,
                        user_name: log.user_name,
                      }) : undefined}
                    />
                  )}
                </View>
              );
            }}
            ListEmptyComponent={
              <View style={s.empty}>
                <Text style={s.emptyText}>No log entries</Text>
              </View>
            }
          />
        )}
      </View>

      {/* ── Log-detail map modal ──────────────────────────────────────── */}
      <Modal
        visible={mapLog !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setMapLog(null)}
      >
        <View style={s.modalBackdrop}>
          <View style={s.modalCard}>
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>{mapLog ? actionLabel(mapLog.action) : ''}</Text>
              <TouchableOpacity onPress={() => setMapLog(null)} hitSlop={10}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            {mapLog && (
              <>
                <MapDisplay latitude={mapLog.latitude} longitude={mapLog.longitude} height={240} />
                <View style={s.modalDetails}>
                  {mapLog.user_name ? (
                    <Text style={s.modalDetailText}>{mapLog.user_name}</Text>
                  ) : null}
                  {mapLog.quantity != null && mapLog.unit && (
                    <Text style={s.modalDetailText}>
                      {mapLog.quantity} {mapLog.unit}
                    </Text>
                  )}
                  {mapLog.note ? <Text style={s.modalDetailText}>{mapLog.note}</Text> : null}
                  <Text style={s.modalDetailText}>
                    {new Date(mapLog.created_at).toLocaleString()}
                  </Text>
                  {mapLog.location_accuracy != null && (
                    <Text style={s.modalAccuracy}>
                      ±{Math.round(mapLog.location_accuracy)}m accuracy
                    </Text>
                  )}
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  filterRow: { flexDirection: 'row', gap: 8, padding: 12, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: '#F1F5F9',
    borderRadius: 20,
  },
  chipActive: { backgroundColor: colors.primaryBgStrong },
  chipText: { fontSize: 13, color: colors.textSecondary },
  chipTextActive: { color: colors.primaryText, fontWeight: '600' },

  // All-Activity filter panel
  filterControls: {
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 8,
  },
  searchInput: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    height: 44,
    fontSize: 13,
    color: colors.textPrimary,
  },
  dateRow: { flexDirection: 'row', gap: 8 },
  dateInput: {
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
    height: 44,
    fontSize: 13,
    color: colors.textPrimary,
  },
  flex1: { flex: 1 },
  clearBtn: { alignSelf: 'flex-end', paddingVertical: 4 },
  clearBtnText: { fontSize: 13, color: colors.primaryText, fontWeight: '600' },

  // Log rows
  list: { padding: 12, gap: 8 },
  card: {
    backgroundColor: colors.surface,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  icon: { fontSize: 20, width: 28, textAlign: 'center' },
  middle: { flex: 1 },
  action: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.textPrimary,
    textTransform: 'capitalize',
  },
  user: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  subtitle: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  qty: { fontSize: 12, color: colors.success, marginTop: 2 },
  note: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  right: { alignItems: 'flex-end', gap: 4 },
  date: { fontSize: 11, color: colors.textMuted },
  pending: { fontSize: 10, color: '#F59E0B', fontWeight: '600' },
  chevron: { fontSize: 11, color: colors.textMuted },
  empty: { alignItems: 'center', paddingTop: 40 },
  emptyText: { fontSize: 14, color: colors.textMuted },

  // Log-detail map modal
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    padding: 16,
    gap: 12,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.textPrimary,
    textTransform: 'capitalize',
  },
  modalClose: { fontSize: 18, color: colors.textMuted, padding: 4 },
  modalDetails: { gap: 4 },
  modalDetailText: { fontSize: 13, color: colors.textSecondary },
  modalAccuracy: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
});
