import { useState, useCallback, useRef } from 'react';
import {
  View, TextInput, FlatList, StyleSheet, TouchableOpacity, Text, ActivityIndicator,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { ItemCard } from '../../../src/components/ItemCard';
import { searchItems } from '../../../src/db/queries/items';
import { PermissionGate } from '../../../src/components/PermissionGate';

interface Item {
  id: string;
  name: string;
  barcode: string | null;
  unit: string;
  unit_category: string;
  total_stock: number;
}

const PAGE_SIZE = 20;

type FilterCategory = 'all' | 'liquid' | 'piece' | 'length' | 'weight';

const FILTER_LABELS: Record<FilterCategory, string> = {
  all: 'All', liquid: 'Liquids', piece: 'Pieces', length: 'Length', weight: 'Weight',
};

export default function InventoryScreen() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterCategory>('all');
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSearch = useCallback((q: string, cat: FilterCategory, newOffset: number, append = false) => {
    setLoading(true);
    const catFilter = cat === 'all' ? undefined : cat;
    const rows = searchItems(q, PAGE_SIZE, newOffset, catFilter) as Item[];
    if (append) {
      setItems(prev => [...prev, ...rows]);
    } else {
      setItems(rows);
    }
    setHasMore(rows.length === PAGE_SIZE);
    setOffset(newOffset + rows.length);
    setLoading(false);
  }, []);

  const handleSearch = (text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      runSearch(text, filter, 0);
    }, 150);
  };

  const handleFilter = (cat: FilterCategory) => {
    setFilter(cat);
    runSearch(query, cat, 0);
  };

  const loadMore = () => {
    if (loading || !hasMore) return;
    runSearch(query, filter, offset, true);
  };

  const handleCheckout = (itemId: string) => {
    router.push({ pathname: '/(app)/(checkout)', params: { itemId } });
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Inventory', headerShown: true }} />
      <View style={styles.container}>
        <View style={styles.searchRow}>
          <View style={styles.searchBox}>
            <Text style={styles.searchIcon}>🔍</Text>
            <TextInput
              style={styles.searchInput}
              placeholder="Search items or barcode..."
              placeholderTextColor="#94A3B8"
              value={query}
              onChangeText={handleSearch}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
          </View>
          <TouchableOpacity
            style={styles.scanBtn}
            onPress={() => router.push('/(app)/(inventory)/scan')}
          >
            <Text style={styles.scanIcon}>⬛</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.filters}>
          {(Object.keys(FILTER_LABELS) as FilterCategory[]).map(cat => (
            <TouchableOpacity
              key={cat}
              style={[styles.chip, filter === cat && styles.chipActive]}
              onPress={() => handleFilter(cat)}
            >
              <Text style={[styles.chipText, filter === cat && styles.chipTextActive]}>
                {FILTER_LABELS[cat]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        <FlatList
          data={items}
          keyExtractor={i => i.id}
          renderItem={({ item }) => (
            <ItemCard item={item} onCheckout={handleCheckout} />
          )}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          ListEmptyComponent={
            loading ? null : (
              <View style={styles.empty}>
                <Text style={styles.emptyText}>
                  {query ? `No items matching "${query}"` : 'Search or browse items above'}
                </Text>
                <PermissionGate permission="edit_inventory">
                  <TouchableOpacity
                    style={styles.addItemBtn}
                    onPress={() => router.push('/(app)/(inventory)/add')}
                  >
                    <Text style={styles.addItemText}>+ Add Item to Catalog</Text>
                  </TouchableOpacity>
                </PermissionGate>
              </View>
            )
          }
          ListFooterComponent={
            loading ? <ActivityIndicator style={styles.loader} color="#2563EB" /> : null
          }
        />

        <PermissionGate permission="edit_inventory">
          <TouchableOpacity
            style={styles.fab}
            onPress={() => router.push('/(app)/(inventory)/add')}
          >
            <Text style={styles.fabText}>+</Text>
          </TouchableOpacity>
        </PermissionGate>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF' },
  searchRow: { flexDirection: 'row', gap: 10, padding: 12, paddingBottom: 6 },
  searchBox: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: '#fff', borderRadius: 10,
    borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 12,
  },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, height: 42, fontSize: 15, color: '#1E293B' },
  scanBtn: {
    width: 44, height: 44, backgroundColor: '#2563EB', borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  scanIcon: { fontSize: 20 },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 8, flexWrap: 'wrap' },
  chip: { paddingHorizontal: 12, paddingVertical: 5, backgroundColor: '#F1F5F9', borderRadius: 20 },
  chipActive: { backgroundColor: '#DBEAFE' },
  chipText: { fontSize: 13, color: '#64748B' },
  chipTextActive: { color: '#1D4ED8', fontWeight: '600' },
  list: { flex: 1 },
  listContent: { padding: 12, paddingBottom: 80 },
  empty: { alignItems: 'center', marginTop: 60, gap: 16 },
  emptyText: { fontSize: 15, color: '#94A3B8', textAlign: 'center' },
  addItemBtn: { backgroundColor: '#2563EB', borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10 },
  addItemText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  loader: { padding: 20 },
  fab: {
    position: 'absolute', bottom: 24, right: 24,
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: '#2563EB', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2, shadowRadius: 4, elevation: 5,
  },
  fabText: { fontSize: 28, color: '#fff', lineHeight: 32 },
});
