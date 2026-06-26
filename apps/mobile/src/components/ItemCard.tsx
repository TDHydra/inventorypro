import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { useRouter } from 'expo-router';
import { formatQuantity } from '../constants/units';
import { getStockByItem } from '../db/queries/items';
import { usePermission } from '../hooks/usePermission';

interface ItemRow {
  id: string;
  name: string;
  barcode: string | null;
  unit: string;
  unit_category: string;
  total_stock: number;
}

interface StockRow {
  location_id: string;
  location_name: string;
  parent_name: string | null;
  quantity: number;
}

interface Props {
  item: ItemRow;
  onCheckout?: (itemId: string) => void;
}

export function ItemCard({ item, onCheckout }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [stock, setStock] = useState<StockRow[] | null>(null);
  const router = useRouter();
  const canCheckout = usePermission('checkout_inventory');
  const canEdit = usePermission('edit_inventory');

  function toggle() {
    if (!expanded && stock === null) {
      const rows = getStockByItem(item.id);
      setStock(rows as unknown as StockRow[]);
    }
    setExpanded(e => !e);
  }

  const totalDisplay = formatQuantity(item.total_stock, item.unit, item.unit_category as any);
  const lowStock = item.total_stock <= 0;

  return (
    <View style={styles.card}>
      <TouchableOpacity style={styles.header} onPress={toggle} activeOpacity={0.7}>
        <View style={styles.headerLeft}>
          <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
          {item.barcode && <Text style={styles.barcode}>{item.barcode}</Text>}
        </View>
        <View style={styles.headerRight}>
          <Text style={[styles.stock, lowStock && styles.stockLow]}>{totalDisplay}</Text>
          <Text style={styles.chevron}>{expanded ? '▲' : '▼'}</Text>
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.expanded}>
          {stock === null || stock.length === 0 ? (
            <Text style={styles.noStock}>No stock tracked at any location</Text>
          ) : (
            stock.map(s => (
              <View key={s.location_id} style={styles.locationRow}>
                <View style={styles.locationInfo}>
                  {s.parent_name && (
                    <Text style={styles.parentName}>{s.parent_name} ›</Text>
                  )}
                  <Text style={styles.locationName}>{s.location_name}</Text>
                </View>
                <Text style={[
                  styles.locationQty,
                  s.quantity <= 0 && styles.locationQtyZero,
                ]}>
                  {formatQuantity(s.quantity, item.unit, item.unit_category as any)}
                </Text>
              </View>
            ))
          )}

          <View style={styles.actions}>
            {canCheckout && onCheckout && (
              <TouchableOpacity
                style={styles.btnPrimary}
                onPress={() => onCheckout(item.id)}
              >
                <Text style={styles.btnPrimaryText}>Check Out</Text>
              </TouchableOpacity>
            )}
            {canEdit && (
              <TouchableOpacity
                style={styles.btnSecondary}
                onPress={() => router.push({ pathname: '/(app)/(inventory)/[id]', params: { id: item.id } })}
              >
                <Text style={styles.btnSecondaryText}>Edit</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    overflow: 'hidden',
    marginBottom: 8,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
  },
  headerLeft: { flex: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { fontSize: 15, fontWeight: '600', color: '#1E293B' },
  barcode: { fontSize: 11, color: '#94A3B8', marginTop: 2 },
  stock: { fontSize: 14, fontWeight: '600', color: '#16A34A' },
  stockLow: { color: '#DC2626' },
  chevron: { fontSize: 11, color: '#94A3B8' },
  expanded: {
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 6,
  },
  noStock: { fontSize: 13, color: '#94A3B8', textAlign: 'center', paddingVertical: 8 },
  locationRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  locationInfo: { flex: 1 },
  parentName: { fontSize: 11, color: '#94A3B8' },
  locationName: { fontSize: 13, color: '#475569' },
  locationQty: { fontSize: 13, fontWeight: '600', color: '#334155' },
  locationQtyZero: { color: '#CBD5E1' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 8 },
  btnPrimary: {
    flex: 1, backgroundColor: '#2563EB', borderRadius: 8,
    paddingVertical: 9, alignItems: 'center',
  },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  btnSecondary: {
    paddingHorizontal: 16, backgroundColor: '#F1F5F9', borderRadius: 8,
    paddingVertical: 9, alignItems: 'center',
  },
  btnSecondaryText: { color: '#475569', fontWeight: '600', fontSize: 14 },
});
