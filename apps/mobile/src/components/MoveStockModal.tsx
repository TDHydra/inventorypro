import { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, Alert,
} from 'react-native';
import { colors } from '../theme';
import { ModalSheet } from './ui/ModalSheet';
import { PrimaryButton } from './ui/PrimaryButton';
import { AppInput } from './ui/AppInput';
import { FieldLabel } from './ui/FieldLabel';
import { confirmDestructive } from '../lib/confirm';
import { getStockAtLocation, getAllLocations } from '../db/queries/locations';
import { adjustStock, getStockQuantity, getItemById } from '../db/queries/items';
import { appendLog } from '../db/queries/log';
import { appendOutbox } from '../sync/outbox';
import { useSession } from '../hooks/useSession';
import { SearchablePicker, PickerOption } from './SearchablePicker';

interface Props {
  visible: boolean;
  fromLocationId: string;
  fromLocationName: string;
  /** Called when the user taps Cancel or the transfer completes. */
  onClose: () => void;
  /** Called only after a successful transfer; parent should refresh its stock. */
  onDone: () => void;
}

/**
 * MoveStockModal — transfers count-based stock between two locations.
 *
 * Picker options:
 *   - Item: from `getStockAtLocation(fromLocationId)` (only items with qty > 0)
 *   - Destination: from `getAllLocations()` excluding the source location
 *
 * On confirm:
 *   1. adjustStock(itemId, fromLocationId, -qty)  [deducts from source]
 *   2. adjustStock(itemId, destLocationId, +qty)  [adds to destination]
 *   3. appendOutbox UPDATE for both stock_by_location rows (absolute quantities)
 *   4. appendLog 'transfer' with from/to/qty/unit
 */
export default function MoveStockModal({
  visible,
  fromLocationId,
  fromLocationName,
  onClose,
  onDone,
}: Props) {
  const { user } = useSession();

  // Load data once (these are sync queries, so useMemo is fine)
  const stock = useMemo(() => getStockAtLocation(fromLocationId), [fromLocationId]);
  const allLocs = useMemo(() => getAllLocations(), [visible]);

  const itemOptions = useMemo<PickerOption[]>(
    () => stock.map(s => ({ id: s.item_id, label: s.name, sublabel: `${s.quantity} on hand` })),
    [stock],
  );

  const locOptions = useMemo<PickerOption[]>(
    () =>
      allLocs
        .filter(l => l.id !== fromLocationId)
        .map(l => ({ id: l.id, label: l.name })),
    [allLocs, fromLocationId],
  );

  const [selectedItem, setSelectedItem] = useState<PickerOption | null>(null);
  const [destLoc, setDestLoc] = useState<PickerOption | null>(null);
  const [qtyText, setQtyText] = useState('');

  function reset() {
    setSelectedItem(null);
    setDestLoc(null);
    setQtyText('');
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleConfirm() {
    if (!selectedItem) {
      Alert.alert('Required', 'Select an item to move.');
      return;
    }
    if (!destLoc) {
      Alert.alert('Required', 'Select a destination location.');
      return;
    }
    const qty = parseInt(qtyText, 10);
    if (!qtyText || isNaN(qty) || qty <= 0) {
      Alert.alert('Invalid quantity', 'Enter a whole number greater than 0.');
      return;
    }

    const itemId = selectedItem.id;
    // Read on-hand quantity live to avoid using a stale snapshot from mount time.
    const currentOnHand = getStockQuantity(itemId, fromLocationId);

    if (qty > currentOnHand) {
      Alert.alert('Not enough stock', `Only ${currentOnHand} on hand at this location.`);
      return;
    }

    // Read the destination's current qty BEFORE adjustment so we can compute
    // the intended absolute values for the outbox payloads.
    const destCurrentQty = getStockQuantity(itemId, destLoc.id);
    const intendedFromQty = Math.max(0, currentOnHand - qty);
    const intendedToQty = destCurrentQty + qty;

    // Pre-read unit for the confirm message
    const item = getItemById(itemId);
    const unit = item?.unit ?? null;
    const unitLabel = unit ? ` ${unit}` : '';

    confirmDestructive({
      title: 'Move stock?',
      message: `Move ${qty}${unitLabel} from ${fromLocationName} to ${destLoc.label}? This updates stock at both locations.`,
      confirmLabel: 'Move',
      onConfirm: () => {
        const now = new Date().toISOString();

        // Adjust stock (adjustStock handles the INSERT OR REPLACE in SQLite)
        adjustStock(itemId, fromLocationId, -qty);
        adjustStock(itemId, destLoc.id, qty);

        // Outbox both stock_by_location rows with intended final quantities.
        // Use INSERT (the server's upsert path: ON CONFLICT (item_id,location_id) DO
        // UPDATE) — a plain UPDATE would match 0 rows when the destination location
        // has no existing row for this item, silently dropping the increment.
        appendOutbox('INSERT', 'stock_by_location', {
          item_id: itemId,
          location_id: fromLocationId,
          quantity: intendedFromQty,
          updated_at: now,
        });
        appendOutbox('INSERT', 'stock_by_location', {
          item_id: itemId,
          location_id: destLoc.id,
          quantity: intendedToQty,
          updated_at: now,
        });

        // Log the transfer; unit already read above for the confirm message.
        appendLog({
          action: 'transfer',
          entity_type: 'item',
          entity_id: itemId,
          from_location_id: fromLocationId,
          to_location_id: destLoc.id,
          quantity: qty,
          unit,
          user_id: user?.id ?? null,
          team_id: null,
          job_id: null,
          note: null,
          metadata: null,
          device_id: null,
        });

        reset();
        onDone();
      },
    });
  }

  const selectedStockRow = selectedItem
    ? stock.find(s => s.item_id === selectedItem.id)
    : null;

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      <Text style={s.title}>Move Stock</Text>
      <Text style={s.fromLabel}>From: {fromLocationName}</Text>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: 14 }}
        showsVerticalScrollIndicator={false}
      >
        <FieldLabel>Item to move</FieldLabel>
        {stock.length === 0 ? (
          <Text style={s.muted}>No stock available at this location.</Text>
        ) : (
          <SearchablePicker
            placeholder="Search items…"
            options={itemOptions}
            value={selectedItem}
            onSelect={(opt) => {
              // Tapping "Change" re-passes the current selection — treat as clear
              setSelectedItem(prev => (prev?.id === opt.id ? null : opt));
              setQtyText('');
            }}
          />
        )}

        <FieldLabel>Destination</FieldLabel>
        <SearchablePicker
          placeholder="Search locations…"
          options={locOptions}
          value={destLoc}
          onSelect={(opt) => setDestLoc(prev => (prev?.id === opt.id ? null : opt))}
        />

        <View>
          <FieldLabel>Quantity</FieldLabel>
          {selectedStockRow != null && (
            <Text style={s.onHand}>{selectedStockRow.quantity} on hand</Text>
          )}
        </View>
        <AppInput
          placeholder="Quantity *"
          value={qtyText}
          onChangeText={setQtyText}
          keyboardType="numeric"
        />

        <PrimaryButton label="Move Stock" onPress={handleConfirm} style={s.moveBtn} />
        <View style={s.secondaryRow}>
          <TouchableOpacity style={s.linkBtn} onPress={handleClose}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </ModalSheet>
  );
}

const s = StyleSheet.create({
  title: { fontSize: 18, fontWeight: '700', color: colors.textPrimary, marginBottom: 2 },
  fromLabel: { fontSize: 13, color: colors.textSecondary, marginBottom: 14 },
  onHand: { fontSize: 12, color: colors.success, fontWeight: '600', marginTop: 4 },
  muted: { fontSize: 14, color: colors.textMuted },
  moveBtn: { marginTop: 8 },
  secondaryRow: {
    flexDirection: 'row', justifyContent: 'center',
    gap: 28, marginTop: 4, marginBottom: 8,
  },
  linkBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  cancelText: { color: colors.textMuted, fontSize: 15, fontWeight: '600' },
});
