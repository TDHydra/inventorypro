import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { colors } from '../../theme';
import { PrimaryButton } from '../ui/PrimaryButton';

export interface ScanReceiptEntry {
  id: string;            // generateUUID at creation time
  itemName: string;
  direction: 'in' | 'out';
  qtyLabel: string;      // e.g. "4 gallon" (formatQuantity output)
  destLabel: string;     // e.g. "Job: Smith St" / "Office" / "Shelf A1"
  at: string;            // ISO timestamp
}

interface Props {
  entries: ScanReceiptEntry[];
  onAddMore: () => void;
  onDone: () => void;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// Session summary: one card per scanned action (item, in/out badge, qty,
// destination, time) plus "Add more" and "Done" actions. Mirrors checkout's
// confirmCard/confirmRow styling.
export function ScanReceipt({ entries, onAddMore, onDone }: Props) {
  return (
    <View style={s.wrap}>
      <Text style={s.title}>Scan summary</Text>
      <ScrollView
        style={s.list}
        contentContainerStyle={s.listContent}
        keyboardShouldPersistTaps="handled"
      >
        {entries.length === 0 && <Text style={s.empty}>No items scanned yet.</Text>}
        {entries.map(e => (
          <View key={e.id} style={s.confirmCard}>
            <View style={s.confirmRow}>
              <Text style={s.itemName}>{e.itemName}</Text>
              <View style={[s.badge, e.direction === 'out' ? s.badgeOut : s.badgeIn]}>
                <Text style={[s.badgeText, e.direction === 'out' ? s.badgeTextOut : s.badgeTextIn]}>
                  {e.direction === 'out' ? 'OUT' : 'IN'}
                </Text>
              </View>
            </View>
            <View style={s.confirmRow}>
              <Text style={s.confirmLabel}>Quantity</Text>
              <Text style={s.confirmValue}>{e.qtyLabel}</Text>
            </View>
            <View style={s.confirmRow}>
              <Text style={s.confirmLabel}>Destination</Text>
              <Text style={s.confirmValue}>{e.destLabel}</Text>
            </View>
            <View style={s.confirmRow}>
              <Text style={s.confirmLabel}>Time</Text>
              <Text style={s.confirmValue}>{formatTime(e.at)}</Text>
            </View>
          </View>
        ))}
      </ScrollView>
      <View style={s.actions}>
        <PrimaryButton label="➕ Add more" onPress={onAddMore} tone="primary" style={s.actionBtn} />
        <PrimaryButton label="Done" onPress={onDone} tone="primary" style={s.actionBtn} />
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.background },
  title: { fontSize: 22, fontWeight: '700', color: colors.brand, padding: 16 },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 16, paddingBottom: 16, gap: 12 },
  empty: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginTop: 24 },
  confirmCard: {
    backgroundColor: colors.surface, borderRadius: 12, borderWidth: 1,
    borderColor: colors.border, padding: 16, gap: 12,
  },
  confirmRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  confirmLabel: { fontSize: 14, color: colors.textSecondary },
  confirmValue: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, flex: 1, textAlign: 'right' },
  itemName: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, flex: 1 },
  badge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 8 },
  badgeOut: { backgroundColor: colors.accentBg },
  badgeIn: { backgroundColor: colors.primaryBg },
  badgeText: { fontSize: 12, fontWeight: '700' },
  badgeTextOut: { color: colors.accent },
  badgeTextIn: { color: colors.primaryText },
  actions: {
    flexDirection: 'row', gap: 12, padding: 16,
    borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surface,
  },
  actionBtn: { flex: 1 },
});
