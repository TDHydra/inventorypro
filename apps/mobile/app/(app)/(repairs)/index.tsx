import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { getRepairs, Repair } from '../../../src/db/queries/repairs';
import { getTypeIcon, isTerminalStatus } from '../../../src/db/queries/taxonomy';
import { colors } from '../../../src/theme';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { Card } from '../../../src/components/ui/Card';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { syncNow } from '../../../src/sync/engine';
import { useDataVersion } from '../../../src/hooks/useDataVersion';

type StatusFilter = 'open' | 'done' | 'all';

// Compact relative age from an ISO timestamp (e.g. "3d", "5h", "just now").
function ageLabel(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

export default function RepairsScreen() {
  const router = useRouter();
  const [filter, setFilter] = useState<StatusFilter>('open');
  const [reloadKey, setReloadKey] = useState(0);
  const reloadLocalData = useCallback(() => setReloadKey(k => k + 1), []);
  const dataVersion = useDataVersion();

  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — local reload still runs */ }
    reloadLocalData();
    setRefreshing(false);
  }, [refreshing, reloadLocalData]);

  // Include dataVersion so an already-open list refreshes after a background
  // sync pull applies changes, without a manual pull-to-refresh.
  const repairs = useMemo((): Repair[] => {
    const done = filter === 'all' ? undefined : filter === 'done';
    return getRepairs({ done });
  }, [filter, reloadKey, dataVersion]);

  return (
    <>
      <Stack.Screen options={{ title: 'Repairs', headerShown: true }} />
      <View style={s.container}>
        <View style={s.filterRow}>
          {(['open', 'done', 'all'] as StatusFilter[]).map(f => (
            <FilterChip
              key={f}
              label={f.charAt(0).toUpperCase() + f.slice(1)}
              active={filter === f}
              onPress={() => setFilter(f)}
            />
          ))}
        </View>

        <FlatList
          data={repairs}
          keyExtractor={r => r.id}
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          renderItem={({ item }) => {
            const icon = getTypeIcon('repair_status', item.status);
            const completed = item.completed_at != null;
            const terminal = completed || isTerminalStatus(item.status);
            const overdue = !!item.due_at && !terminal && new Date(item.due_at).getTime() < Date.now();
            return (
              <TouchableOpacity
                onPress={() =>
                  router.push({ pathname: '/(app)/(repairs)/[id]', params: { id: item.id } })
                }
              >
                <Card variant="list">
                  <Text style={s.cardName}>{item.entity_label ?? '(unlabeled)'}</Text>
                  <View style={s.cardRow}>
                    <View style={[
                      s.statusBadge,
                      terminal ? s.statusBadgeDone : s.statusBadgeOpen,
                    ]}>
                      <Text style={[
                        s.statusBadgeText,
                        terminal ? s.statusBadgeTextDone : s.statusBadgeTextOpen,
                      ]}>
                        {icon ? `${icon} ` : ''}{item.status}
                      </Text>
                    </View>
                    {overdue && (
                      <View style={s.overdueBadge}>
                        <Text style={s.overdueBadgeText}>Overdue</Text>
                      </View>
                    )}
                    <Text style={s.cardDate}>{ageLabel(item.created_at)}</Text>
                  </View>
                </Card>
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <EmptyState
              title="No repairs"
              subtitle={
                filter === 'open' ? 'No open repair tickets.'
                  : filter === 'done' ? 'No completed repairs yet.'
                  : 'No repair tickets recorded.'
              }
            />
          }
        />
      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  filterRow: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12,
    paddingVertical: 10, gap: 8,
  },
  list: { padding: 12, gap: 8, paddingBottom: 80 },
  cardName: { fontSize: 15, fontWeight: '600', color: colors.textPrimary, marginBottom: 4 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusBadge: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10,
    borderWidth: 1,
  },
  statusBadgeOpen: { backgroundColor: colors.primaryBg, borderColor: colors.primary },
  statusBadgeDone: { backgroundColor: colors.surface, borderColor: colors.success },
  statusBadgeText: { fontSize: 12, fontWeight: '600' },
  statusBadgeTextOpen: { color: colors.primary },
  statusBadgeTextDone: { color: colors.success },
  overdueBadge: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10,
    borderWidth: 1, backgroundColor: colors.dangerBg, borderColor: colors.danger,
  },
  overdueBadgeText: { fontSize: 11, fontWeight: '700', color: colors.danger },
  cardDate: { fontSize: 12, color: colors.textMuted, marginLeft: 'auto' as any },
});
