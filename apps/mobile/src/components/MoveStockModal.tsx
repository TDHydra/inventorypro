import { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { Alert } from '../lib/themedAlert';
import type { Theme } from '../themes/types';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { ModalSheet } from './ui/ModalSheet';
import { PrimaryButton } from './ui/PrimaryButton';
import { AppInput } from './ui/AppInput';
import { FieldLabel } from './ui/FieldLabel';
import { confirmDestructive } from '../lib/confirm';
import { parseQuantity } from '../lib/validation';
import { runInTransaction } from '../db/tx';
import { getStockAtLocation, resolveLocationShelfSelection } from '../db/queries/locations';
import { getUnitInventoryLock } from '../db/queries/access';
import { adjustStock, getStockQuantity, getItemById } from '../db/queries/items';
import { appendLog } from '../db/queries/log';
import { appendOutbox } from '../sync/outbox';
import { useSession } from '../hooks/useSession';
import { useTableVersion } from '../hooks/useDataVersion';
import { SearchablePicker, PickerOption } from './SearchablePicker';
import { LocationShelfPicker } from './pickers';
import { track } from '../telemetry';

// Audit a validation rejection — field path + rule name ONLY, never the value.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'move_stock', props: { field, rule } });
}

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
 *   - Destination: the shared two-stage LocationShelfPicker (shelf-free location
 *     list + Shelf sub-field), proximity-sorted, excluding the source location
 *
 * On confirm (all inside one transaction):
 *   1. resolve (location, shelf) → destination id (creating a typed-in shelf)
 *   2. adjustStock(itemId, fromLocationId, -qty)  [deducts from source]
 *   3. adjustStock(itemId, destId, +qty)          [adds to destination]
 *   4. appendOutbox ADJUST for both stock_by_location rows (signed deltas)
 *   5. appendLog 'transfer' with from/to/qty/unit
 */
export default function MoveStockModal({
  visible,
  fromLocationId,
  fromLocationName,
  onClose,
  onDone,
}: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();

  // Re-read source stock when a sync pull (or local write) touches it, so the
  // item list stays fresh while the modal is mounted/open.
  const stockVersion = useTableVersion(['stock_by_location']);
  const stock = useMemo(() => getStockAtLocation(fromLocationId), [fromLocationId, stockVersion]);

  const itemOptions = useMemo<PickerOption[]>(
    () => stock.map(s => ({ id: s.item_id, label: s.name, sublabel: `${s.quantity} on hand` })),
    [stock],
  );

  const [selectedItem, setSelectedItem] = useState<PickerOption | null>(null);
  const [destLoc, setDestLoc] = useState<PickerOption | null>(null);
  const [destShelf, setDestShelf] = useState<PickerOption | null>(null);
  const [qtyText, setQtyText] = useState('');

  // #162 team-scoped unit inventory: moving stock OUT OF (source) or INTO
  // (destination) another team's vehicle/locker is locked without
  // manage_other_team_inventory. Shelves only exist under MAIN locations
  // (units can't have sub-areas), so checking destLoc.id covers the shelf case.
  const sourceLock = useMemo(
    () => getUnitInventoryLock(user, fromLocationId),
    [user?.id, fromLocationId, stockVersion],
  );
  const destLock = useMemo(
    () => getUnitInventoryLock(user, destLoc?.id),
    [user?.id, destLoc?.id, stockVersion],
  );
  const teamLockReason = sourceLock.locked ? sourceLock.reason : destLock.locked ? destLock.reason : null;

  function reset() {
    setSelectedItem(null);
    setDestLoc(null);
    setDestShelf(null);
    setQtyText('');
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleConfirm() {
    // #162: locked source/destination — mirror of the server guard; say why.
    if (teamLockReason) {
      trackReject('stock.location', 'foreign_team_unit');
      Alert.alert('Team inventory', teamLockReason);
      return;
    }
    if (!selectedItem) {
      trackReject('stock.item', 'required');
      Alert.alert('Required', 'Select an item to move.');
      return;
    }
    if (!destLoc) {
      trackReject('stock.destination', 'required');
      Alert.alert('Required', 'Select a destination location.');
      return;
    }
    const qtyResult = parseQuantity(qtyText, 'Quantity');
    if (!qtyResult.ok) {
      trackReject('stock.qty', qtyResult.rule);
      Alert.alert('Invalid quantity', qtyResult.error);
      return;
    }
    const qty = qtyResult.value;

    const itemId = selectedItem.id;
    // Read on-hand quantity live to avoid using a stale snapshot from mount time.
    const currentOnHand = getStockQuantity(itemId, fromLocationId);

    if (qty > currentOnHand) {
      trackReject('stock.qty', 'exceeds_on_hand');
      Alert.alert('Not enough stock', `Only ${currentOnHand} on hand at this location.`);
      return;
    }

    // Pre-read unit for the confirm message
    const item = getItemById(itemId);
    const unit = item?.unit ?? null;
    const unitLabel = unit ? ` ${unit}` : '';

    confirmDestructive({
      title: 'Move stock?',
      message: `Move ${qty}${unitLabel} from ${fromLocationName} to ${destLoc.label}${destShelf ? ` (shelf ${destShelf.label})` : ''}? This updates stock at both locations.`,
      confirmLabel: 'Move',
      onConfirm: () => {
        const now = new Date().toISOString();

        try {
          // All writes go in ONE transaction so a mid-flow failure rolls back
          // atomically — never deduct from source without crediting destination.
          // The shelf resolve (which may CREATE the typed-in shelf) happens inside
          // too, so a failed transfer can't leave an orphaned new shelf behind.
          runInTransaction(() => {
            const dest = resolveLocationShelfSelection(destLoc, destShelf);
            if (!dest.ok || !dest.id) throw new Error('Could not resolve the shelf destination');

            // Adjust stock (adjustStock handles the INSERT OR REPLACE in SQLite)
            adjustStock(itemId, fromLocationId, -qty);
            adjustStock(itemId, dest.id, qty);

            // Outbox SIGNED deltas for both rows; the server merges authoritatively
            // (idempotent + clamped via ADJUST), creating the destination row if absent.
            appendOutbox('ADJUST', 'stock_by_location', {
              item_id: itemId,
              location_id: fromLocationId,
              delta: -qty,
              updated_at: now,
            });
            appendOutbox('ADJUST', 'stock_by_location', {
              item_id: itemId,
              location_id: dest.id,
              delta: qty,
              updated_at: now,
            });

            // Log the transfer; unit already read above for the confirm message.
            appendLog({
              action: 'transfer',
              entity_type: 'item',
              entity_id: itemId,
              from_location_id: fromLocationId,
              to_location_id: dest.id,
              quantity: qty,
              unit,
              user_id: user?.id ?? null,
              team_id: null,
              job_id: null,
              note: null,
              metadata: null,
              device_id: null,
            });
          });
        } catch (err) {
          // Nothing was committed — keep the form intact so the user can retry.
          Alert.alert(
            'Move failed',
            `Could not move stock: ${err instanceof Error ? err.message : String(err)}. Nothing was changed.`,
          );
          return;
        }

        // Only clear the form and notify the parent after the commit succeeded.
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
        <LocationShelfPicker
          proximitySort
          excludeIds={[fromLocationId]}
          locationValue={destLoc}
          shelfValue={destShelf}
          onChangeLocation={setDestLoc}
          onChangeShelf={setDestShelf}
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

        {!!teamLockReason && <Text style={s.lockReason}>{teamLockReason}</Text>}
        <PrimaryButton label="Move Stock" onPress={handleConfirm} disabled={!!teamLockReason} style={s.moveBtn} />
        <View style={s.secondaryRow}>
          <TouchableOpacity style={s.linkBtn} onPress={handleClose}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  title: { fontSize: 18, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 2 },
  fromLabel: { fontSize: 13, color: t.colors.textSecondary, marginBottom: 14 },
  onHand: { fontSize: 12, color: t.colors.success, fontWeight: '600', marginTop: 4 },
  muted: { fontSize: 14, color: t.colors.textMuted },
  lockReason: { fontSize: 13, fontWeight: '600', color: t.colors.danger, textAlign: 'center' },
  moveBtn: { marginTop: 8 },
  secondaryRow: {
    flexDirection: 'row', justifyContent: 'center',
    gap: 28, marginTop: 4, marginBottom: 8,
  },
  linkBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  cancelText: { color: t.colors.textMuted, fontSize: 15, fontWeight: '600' },
});
