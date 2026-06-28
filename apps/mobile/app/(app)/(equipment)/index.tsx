import { useState, useCallback, useRef } from 'react';
import {
  View, Text, TextInput, FlatList, StyleSheet,
  TouchableOpacity, RefreshControl,
} from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { getEquipmentModels } from '../../../src/db/queries/equipment';
import type { EquipmentModel } from '../../../src/db/queries/equipment';
import { MediaThumbnail } from '../../../src/components/MediaThumbnail';
import { Card } from '../../../src/components/ui/Card';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { usePermission } from '../../../src/hooks/usePermission';
import { syncNow } from '../../../src/sync/engine';
import { colors, spacing, fontSizes, radii } from '../../../src/theme';

export default function EquipmentScreen() {
  const router = useRouter();
  const canAdd = usePermission('add_inventory');
  const [query, setQuery] = useState('');
  const [models, setModels] = useState<EquipmentModel[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref so useFocusEffect can always read the latest query without re-registering
  const queryRef = useRef('');
  queryRef.current = query;

  const load = useCallback((q?: string) => {
    setModels(getEquipmentModels(q));
  }, []);

  // Load on mount and on screen focus (e.g. returning from add or detail)
  useFocusEffect(
    useCallback(() => {
      load(queryRef.current.trim() || undefined);
    }, [load]),
  );

  const handleSearch = (text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      load(text.trim() || undefined);
    }, 200);
  };

  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — local reload still runs */ }
    load(queryRef.current.trim() || undefined);
    setRefreshing(false);
  }, [refreshing, load]);

  return (
    <>
      <Stack.Screen options={{ title: 'Equipment', headerShown: true }} />
      <View style={s.container}>

        <View style={s.searchRow}>
          <View style={s.searchBox}>
            <Text style={s.searchIcon}>🔍</Text>
            <TextInput
              style={s.searchInput}
              placeholder="Search equipment..."
              placeholderTextColor={colors.textMuted}
              value={query}
              onChangeText={handleSearch}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
          </View>
          {canAdd && (
            <TouchableOpacity
              style={s.headerAddBtn}
              onPress={() => router.push('/(app)/(equipment)/add')}
              accessibilityLabel="Add equipment model"
            >
              <Text style={s.headerAddText}>＋</Text>
            </TouchableOpacity>
          )}
        </View>

        <FlatList
          data={models}
          keyExtractor={m => m.id}
          renderItem={({ item: m }) => (
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() =>
                router.push({ pathname: '/(app)/(equipment)/[id]', params: { id: m.id } })
              }
            >
              <Card style={s.card}>
                <View style={s.row}>
                  <MediaThumbnail entityType="item" entityId={m.id} size={44} />
                  <View style={s.info}>
                    <Text style={s.name} numberOfLines={1}>{m.name}</Text>
                    <View style={s.chips}>
                      {m.counts.available > 0 && (
                        <View style={[s.chip, s.chipAvail]}>
                          <Text style={s.chipText}>{m.counts.available} avail</Text>
                        </View>
                      )}
                      {m.counts.deployed > 0 && (
                        <View style={[s.chip, s.chipDeploy]}>
                          <Text style={s.chipText}>{m.counts.deployed} out</Text>
                        </View>
                      )}
                      {m.counts.in_repair > 0 && (
                        <View style={[s.chip, s.chipRepair]}>
                          <Text style={s.chipText}>{m.counts.in_repair} repair</Text>
                        </View>
                      )}
                      {m.counts.available + m.counts.deployed +
                        m.counts.in_repair + m.counts.retired === 0 && (
                        <Text style={s.noUnits}>No units</Text>
                      )}
                    </View>
                  </View>
                  <Text style={s.chevron}>›</Text>
                </View>
              </Card>
            </TouchableOpacity>
          )}
          style={s.list}
          contentContainerStyle={s.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          ListEmptyComponent={
            <EmptyState
              title="No equipment models"
              subtitle={
                query
                  ? `No equipment matching "${query}"`
                  : 'Add your first equipment model to get started.'
              }
              cta={
                canAdd
                  ? {
                      label: '＋ Add Equipment',
                      onPress: () => router.push('/(app)/(equipment)/add'),
                    }
                  : undefined
              }
            />
          }
        />

        {canAdd && (
          <TouchableOpacity
            style={s.fab}
            onPress={() => router.push('/(app)/(equipment)/add')}
          >
            <Text style={s.fabText}>+</Text>
          </TouchableOpacity>
        )}

      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  searchRow: {
    flexDirection: 'row', gap: 10, padding: spacing.md, paddingBottom: spacing.sm,
  },
  searchBox: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12,
  },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, height: 42, fontSize: fontSizes.md, color: colors.textPrimary },
  headerAddBtn: {
    width: 44, height: 44, backgroundColor: colors.primary, borderRadius: radii.md,
    alignItems: 'center', justifyContent: 'center',
  },
  headerAddText: { fontSize: 24, color: '#fff', lineHeight: 28 },
  list: { flex: 1 },
  listContent: { padding: spacing.md, paddingBottom: 96 },
  card: { marginBottom: spacing.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  info: { flex: 1, gap: 4 },
  name: { fontSize: fontSizes.body, fontWeight: '700', color: colors.textPrimary },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderRadius: radii.sm, paddingHorizontal: 8, paddingVertical: 2 },
  chipAvail: { backgroundColor: '#D1FAE5' },
  chipDeploy: { backgroundColor: '#DBEAFE' },
  chipRepair: { backgroundColor: '#FEF3C7' },
  chipText: { fontSize: fontSizes.caption, fontWeight: '600', color: colors.textPrimary },
  noUnits: { fontSize: fontSizes.caption, color: colors.textMuted, fontStyle: 'italic' },
  chevron: { fontSize: 22, color: colors.textMuted },
  fab: {
    position: 'absolute', bottom: 24, right: 24,
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2, shadowRadius: 4, elevation: 5,
  },
  fabText: { fontSize: 28, color: '#fff', lineHeight: 32 },
});
