import { useState, useMemo } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { Stack } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { getLogForUser, getUnsyncedLogs } from '../../../src/db/queries/log';
import { rowsAs } from '../../../src/db/schema';
import { PermissionGate } from '../../../src/components/PermissionGate';

interface LogRow {
  id: string;
  user_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  quantity: number | null;
  unit: string | null;
  job_id: string | null;
  note: string | null;
  created_at: string;
  synced_at: string | null;
}

const ACTION_ICONS: Record<string, string> = {
  checkout: '📦', checkin: '↩', login: '👤',
  add_stock: '+', transfer: '⇄', delete: '🗑',
};

type Filter = 'mine' | 'unsynced';

export default function LogsScreen() {
  const { user } = useSession();
  const [filter, setFilter] = useState<Filter>('mine');

  const logs = useMemo(() => {
    if (!user) return [];
    if (filter === 'unsynced') return rowsAs<LogRow>(getUnsyncedLogs());
    return rowsAs<LogRow>(getLogForUser(user.id, 50));
  }, [user, filter]);

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

        <FlatList
          data={logs}
          keyExtractor={l => l.id}
          contentContainerStyle={s.list}
          renderItem={({ item: log }) => (
            <View style={s.row}>
              <Text style={s.icon}>{ACTION_ICONS[log.action] ?? '·'}</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.action}>{log.action.replace(/_/g, ' ')}</Text>
                {log.quantity != null && log.unit && (
                  <Text style={s.qty}>{log.quantity} {log.unit}</Text>
                )}
                {log.note && <Text style={s.note}>{log.note}</Text>}
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
  filterRow: { flexDirection: 'row', gap: 8, padding: 12 },
  chip: { paddingHorizontal: 14, paddingVertical: 6, backgroundColor: '#F1F5F9', borderRadius: 20 },
  chipActive: { backgroundColor: '#DBEAFE' },
  chipText: { fontSize: 13, color: '#64748B' },
  chipTextActive: { color: '#1D4ED8', fontWeight: '600' },
  list: { padding: 12, gap: 8 },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    backgroundColor: '#fff', padding: 12, borderRadius: 10,
    borderWidth: 1, borderColor: '#E2E8F0',
  },
  icon: { fontSize: 20, width: 28, textAlign: 'center' },
  action: { fontSize: 14, fontWeight: '600', color: '#1E293B', textTransform: 'capitalize' },
  qty: { fontSize: 12, color: '#16A34A', marginTop: 2 },
  note: { fontSize: 12, color: '#64748B', marginTop: 2 },
  right: { alignItems: 'flex-end', gap: 4 },
  date: { fontSize: 11, color: '#94A3B8' },
  pending: { fontSize: 10, color: '#F59E0B', fontWeight: '600' },
  empty: { alignItems: 'center', paddingTop: 40 },
  emptyText: { fontSize: 14, color: '#94A3B8' },
});
