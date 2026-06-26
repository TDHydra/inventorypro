import { useState, useMemo } from 'react';
import {
  View, Text, Modal, TouchableOpacity, StyleSheet,
  TextInput, KeyboardAvoidingView, Platform, ScrollView, Alert,
} from 'react-native';
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

    const now = new Date().toISOString();

    // Adjust stock (adjustStock handles the INSERT OR REPLACE in SQLite)
    adjustStock(itemId, fromLocationId, -qty);
    adjustStock(itemId, destLoc.id, qty);

    // Outbox both stock_by_location rows with intended final quantities.
    // Using absolute quantities ensures the server applies the correct state
    // regardless of local DB edge-cases.
    appendOutbox('UPDATE', 'stock_by_location', {
      item_id: itemId,
      location_id: fromLocationId,
      quantity: intendedFromQty,
      updated_at: now,
    });
    appendOutbox('UPDATE', 'stock_by_location', {
      item_id: itemId,
      location_id: destLoc.id,
      quantity: intendedToQty,
      updated_at: now,
    });

    // Log the transfer; fetch the item's unit for display in the feed.
    const item = getItemById(itemId);
    const unit = item?.unit ?? null;

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
  }

  const selectedStockRow = selectedItem
    ? stock.find(s => s.item_id === selectedItem.id)
    : null;

  return (
    <Modal visible={visible} animationType="slide" transparent>
      <KeyboardAvoidingView
        style={s.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={s.modal}>
          <Text style={s.title}>Move Stock</Text>
          <Text style={s.fromLabel}>From: {fromLocationName}</Text>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 14 }}
            showsVerticalScrollIndicator={false}
          >
            <Text style={s.label}>Item to move</Text>
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

            <Text style={s.label}>Destination</Text>
            <SearchablePicker
              placeholder="Search locations…"
              options={locOptions}
              value={destLoc}
              onSelect={(opt) => setDestLoc(prev => (prev?.id === opt.id ? null : opt))}
            />

            <View>
              <Text style={s.label}>Quantity</Text>
              {selectedStockRow != null && (
                <Text style={s.onHand}>{selectedStockRow.quantity} on hand</Text>
              )}
            </View>
            <TextInput
              style={s.input}
              placeholder="Quantity *"
              placeholderTextColor="#94A3B8"
              value={qtyText}
              onChangeText={setQtyText}
              keyboardType="numeric"
            />

            <TouchableOpacity style={s.btn} onPress={handleConfirm}>
              <Text style={s.btnText}>Move Stock</Text>
            </TouchableOpacity>
            <View style={s.secondaryRow}>
              <TouchableOpacity style={s.linkBtn} onPress={handleClose}>
                <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const s = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end',
  },
  modal: {
    backgroundColor: '#F8FAFF',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '88%',
  },
  title: { fontSize: 18, fontWeight: '700', color: '#1E293B', marginBottom: 2 },
  fromLabel: { fontSize: 13, color: '#64748B', marginBottom: 14 },
  label: {
    fontSize: 12, fontWeight: '700', color: '#64748B',
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  onHand: { fontSize: 12, color: '#16A34A', fontWeight: '600', marginTop: 4 },
  muted: { fontSize: 14, color: '#94A3B8' },
  input: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, height: 44, fontSize: 14, color: '#1E293B',
  },
  btn: {
    backgroundColor: '#2563EB', borderRadius: 12,
    paddingVertical: 13, alignItems: 'center', marginTop: 8,
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryRow: {
    flexDirection: 'row', justifyContent: 'center',
    gap: 28, marginTop: 4, marginBottom: 8,
  },
  linkBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  linkText: { color: '#2563EB', fontSize: 15, fontWeight: '600' },
  cancelText: { color: '#94A3B8' },
});
