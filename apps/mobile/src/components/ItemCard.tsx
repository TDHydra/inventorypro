import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors } from '../theme';
import { useRouter } from 'expo-router';
import { formatQuantity } from '../constants/units';
import { getStockByItem, getItemById, InventoryItem } from '../db/queries/items';
import { getLocationPath } from '../db/queries/locations';
import { isRepairableCategory } from '../constants/repairable';
import { usePermission } from '../hooks/usePermission';
import { resolveTypeColor } from '../constants/typeColors';
import { MediaThumbnail } from './MediaThumbnail';

interface ItemRow {
  id: string;
  name: string;
  barcode: string | null;
  unit: string;
  unit_category: string;
  total_stock: number;
  // Present on search rows (SELECT i.*) — the item-type label drives the color.
  category?: string | null;
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
  typeColorMap?: Record<string, string>;
}

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statKey}>{k}</Text>
      <Text style={styles.statVal} numberOfLines={1}>{v}</Text>
    </View>
  );
}

export function ItemCard({ item, onCheckout, typeColorMap }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [stock, setStock] = useState<StockRow[] | null>(null);
  const [full, setFull] = useState<InventoryItem | null>(null);
  const router = useRouter();
  const canCheckout = usePermission('checkout_inventory');
  const canEdit = usePermission('edit_inventory');

  function toggle() {
    if (!expanded && stock === null) {
      setStock(getStockByItem(item.id) as unknown as StockRow[]);
      setFull(getItemById(item.id));
    }
    setExpanded(e => !e);
  }

  const totalDisplay = formatQuantity(item.total_stock, item.unit, item.unit_category as any);
  const lowStock = item.total_stock <= 0;
  // Item categories are a managed taxonomy → admin override (typeColorMap) wins,
  // else a stable auto color. Empty category → no accent/badge.
  const hasCategory = !!(item.category && item.category.trim());
  const typeColor = resolveTypeColor(item.category, typeColorMap?.[item.category ?? '']);
  const homePath = full?.home_location_id ? getLocationPath(full.home_location_id) : '';
  const unitLabel = full?.pack_size && full.pack_size > 1
    ? `${full.unit} · pack of ${full.pack_size}`
    : (full?.unit ?? item.unit);

  function reportRepair() {
    router.push({
      pathname: '/(app)/(repairs)/new',
      params: { entityType: 'item', entityId: item.id, entityLabel: item.name },
    });
  }
  function openDetail() {
    router.push({ pathname: '/(app)/(inventory)/[id]', params: { id: item.id } });
  }

  return (
    <View style={[styles.card, hasCategory && { borderLeftWidth: 4, borderLeftColor: typeColor }]}>
      <TouchableOpacity style={styles.header} onPress={toggle} activeOpacity={0.7}>
        <MediaThumbnail entityType="item" entityId={item.id} size={44} />
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
          {/* Quick stats / details */}
          {full && (
            <View style={styles.stats}>
              {!!full.sku && <Stat k="Item #" v={full.sku} />}
              {!!full.category && (
                <View style={styles.statRow}>
                  <Text style={styles.statKey}>Type</Text>
                  <View style={[styles.typeBadge, { backgroundColor: typeColor }]}>
                    <Text style={styles.typeBadgeText} numberOfLines={1}>{full.category}</Text>
                  </View>
                </View>
              )}
              <Stat k="Unit" v={unitLabel} />
              {!!homePath && <Stat k="Belongs at" v={homePath} />}
              {full.min_qty_alert > 0 && (
                <Stat k="Low-stock alert" v={`${full.min_qty_alert} ${full.unit}`} />
              )}
            </View>
          )}

          {/* Stock by location */}
          <Text style={styles.sectionLabel}>On hand by location</Text>
          {stock === null || stock.length === 0 ? (
            <Text style={styles.noStock}>No stock tracked at any location</Text>
          ) : (
            stock.map(s => (
              <View key={s.location_id} style={styles.locationRow}>
                <View style={styles.locationInfo}>
                  {s.parent_name && <Text style={styles.parentName}>{s.parent_name} ›</Text>}
                  <Text style={styles.locationName}>{s.location_name}</Text>
                </View>
                <Text style={[styles.locationQty, s.quantity <= 0 && styles.locationQtyZero]}>
                  {formatQuantity(s.quantity, item.unit, item.unit_category as any)}
                </Text>
              </View>
            ))
          )}

          {/* Quick actions — do everything to the item from here */}
          <View style={styles.actions}>
            {canCheckout && onCheckout && item.total_stock > 0 && (
              <TouchableOpacity style={[styles.actBtn, styles.actPrimary]} onPress={() => onCheckout(item.id)}>
                <Text style={styles.actPrimaryText}>Check Out</Text>
              </TouchableOpacity>
            )}
            {canEdit && isRepairableCategory(full?.category) && (
              <TouchableOpacity style={[styles.actBtn, styles.actGhost]} onPress={reportRepair}>
                <Text style={styles.actGhostText}>🔧 Report repair</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.actBtn, styles.actGhost]} onPress={openDetail}>
              <Text style={styles.actGhostText}>{canEdit ? 'Edit / details' : 'Details'}</Text>
            </TouchableOpacity>
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
    borderColor: colors.border,
    overflow: 'hidden',
    marginBottom: 8,
  },
  header: { flexDirection: 'row', alignItems: 'center', padding: 14 },
  headerLeft: { flex: 1, marginLeft: 10 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  barcode: { fontSize: 11, color: colors.textMuted, marginTop: 2 },
  stock: { fontSize: 14, fontWeight: '600', color: colors.success },
  stockLow: { color: colors.danger },
  chevron: { fontSize: 11, color: colors.textMuted },
  expanded: {
    borderTopWidth: 1,
    borderTopColor: '#F1F5F9',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 4,
  },
  stats: {
    backgroundColor: colors.background,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginBottom: 6,
    gap: 2,
  },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 2 },
  statKey: { fontSize: 12, color: colors.textMuted },
  statVal: { fontSize: 12, fontWeight: '600', color: '#334155', flexShrink: 1, marginLeft: 12, textAlign: 'right' },
  typeBadge: { borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, marginLeft: 12, flexShrink: 1 },
  typeBadgeText: { fontSize: 11, fontWeight: '700', color: '#fff' },
  sectionLabel: { fontSize: 11, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', marginTop: 2 },
  noStock: { fontSize: 13, color: colors.textMuted, textAlign: 'center', paddingVertical: 8 },
  locationRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  locationInfo: { flex: 1 },
  parentName: { fontSize: 11, color: colors.textMuted },
  locationName: { fontSize: 13, color: '#475569' },
  locationQty: { fontSize: 13, fontWeight: '600', color: '#334155' },
  locationQtyZero: { color: colors.textDisabled },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  actBtn: { borderRadius: 8, paddingVertical: 9, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' },
  actPrimary: { flexGrow: 1, backgroundColor: colors.primary },
  actPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  actGhost: { backgroundColor: '#F1F5F9' },
  actGhostText: { color: '#475569', fontWeight: '600', fontSize: 13 },
});
