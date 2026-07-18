import { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { searchItems, adjustStock, upsertStock, getStockQuantity, getItemById } from '../../db/queries/items';
import { resolveLocationShelfSelection } from '../../db/queries/locations';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';
import { LocationShelfPicker } from '../pickers';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { PrimaryButton } from '../ui/PrimaryButton';
import { FieldLabel } from '../ui/FieldLabel';
import { FilterChip } from '../ui/FilterChip';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';
import { track } from '../../telemetry';
import { parseStockQuantity } from '../../lib/validation';
import type { QuickAddSaveMeta } from './justAdded';

interface Props {
  onSaved: (label: string, createdId?: string, meta?: QuickAddSaveMeta) => void;
}

type Mode = 'delta' | 'set';

// Audit a validation rejection — field path + rule name ONLY, never the value.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'quick_add', props: { field, rule } });
}

export default function StockQuickAdd({ onSaved }: Props) {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  // Set/recount does an INSERT the server gates on `checkin_inventory`. The
  // screen itself is only client-gated by `quick_add`, so a tier3 role
  // (quick_add=true, checkin_inventory=false) would otherwise save a recount
  // that the server silently rejects. Gate the Set toggle on the same perm the
  // server enforces; Delta (ADJUST) stays available regardless.
  const canRecount = usePermission('checkin_inventory');
  const qtyRef = useRef<TextInput>(null);

  const [selectedLocation, setSelectedLocation] = useState<PickerOption | null>(null); // sticky
  const [shelfValue, setShelfValue] = useState<PickerOption | null>(null);
  const [selectedItemOpt, setSelectedItemOpt] = useState<PickerOption | null>(null);
  const [mode, setMode] = useState<Mode>('delta');
  const [qty, setQty] = useState('');
  const [error, setError] = useState('');

  // Current on-hand qty for the hint shown when recounting ("Set") — only looked
  // up once both a location and item are picked.
  const currentOnHand = useMemo(
    () =>
      mode === 'set' && selectedLocation && selectedItemOpt
        ? getStockQuantity(selectedItemOpt.id, selectedLocation.id)
        : null,
    [mode, selectedLocation, selectedItemOpt],
  );

  // DB-backed search (not a capped pre-load) so the full catalog is reachable.
  const itemSearch = useMemo(
    () => (q: string): PickerOption[] =>
      searchItems(q, 12).map(i => ({ id: i.id, label: i.name, sublabel: i.unit })),
    [],
  );

  function handleSave() {
    track('action', 'quickadd_save_stock', { screen: 'quick_add' });
    if (!selectedLocation) {
      trackReject('stock.location', 'required');
      setError('Select a location.');
      return;
    }
    if (!selectedItemOpt) {
      trackReject('stock.item', 'required');
      setError('Select an item.');
      return;
    }
    // Guard the recount path even if `mode` is somehow stale — the server rejects
    // the INSERT without `checkin_inventory`, so never let it save silently.
    if (mode === 'set' && !canRecount) {
      trackReject('stock.mode', 'forbidden');
      setError('Recount requires check-in permission.');
      return;
    }
    // Delta must be a positive addition; Set is an absolute recount, so 0 is a
    // valid "nothing here" reading. parseStockQuantity keeps the historical
    // parseFloat + copy, adding the overflow bound.
    const qtyResult = parseStockQuantity(qty, mode);
    if (!qtyResult.ok) {
      trackReject('stock.qty', qtyResult.rule);
      setError(qtyResult.error);
      return;
    }
    const parsedQty = qtyResult.value;
    setError('');

    const itemId = selectedItemOpt.id;
    // Resolve the target location: when the location bears shelves and a shelf is
    // chosen, stock is tracked against the shelf (creating it if it's new — which
    // can fail, so guard it). Otherwise the bare location.
    const dest = resolveLocationShelfSelection(selectedLocation, shelfValue);
    if (!dest.ok) {
      setError(`Couldn’t create the shelf “${dest.shelfLabel}”. Pick an existing shelf or try again.`);
      return;
    }
    // id is only null when no location is picked, which is guarded above.
    const locationId = dest.id ?? selectedLocation.id;
    const now = new Date().toISOString();
    const fullItem = getItemById(itemId);
    const itemUnit = fullItem?.unit ?? 'each';

    if (mode === 'set') {
      // Absolute recount — INSERT so the server upserts via ON CONFLICT (item_id,
      // location_id) DO UPDATE (a plain UPDATE would no-op when no stock row exists
      // yet, silently losing the recount). Server clamps ≥0 and forces updated_at.
      upsertStock({ item_id: itemId, location_id: locationId, quantity: parsedQty, updated_at: now });

      appendOutbox('INSERT', 'stock_by_location', {
        item_id: itemId,
        location_id: locationId,
        quantity: parsedQty,
        updated_at: now,
      });
      appendLog({
        action: 'recount',
        entity_type: 'item',
        entity_id: itemId,
        to_location_id: locationId,
        quantity: parsedQty,
        unit: itemUnit,
        user_id: user?.id ?? null,
        team_id: null,
        from_location_id: null,
        job_id: null,
        note: null,
        metadata: null,
        device_id: null,
      });
    } else {
      adjustStock(itemId, locationId, parsedQty);

      appendOutbox('ADJUST', 'stock_by_location', {
        item_id: itemId,
        location_id: locationId,
        delta: parsedQty,
        updated_at: now,
      });
      appendLog({
        action: 'add_stock',
        entity_type: 'item',
        entity_id: itemId,
        to_location_id: locationId,
        quantity: parsedQty,
        unit: itemUnit,
        user_id: user?.id ?? null,
        team_id: null,
        from_location_id: null,
        job_id: null,
        note: null,
        metadata: null,
        device_id: null,
      });
    }

    const locName = selectedLocation.label;
    onSaved(
      mode === 'set'
        ? `Set to ${parsedQty} ${itemUnit} @ ${locName}`
        : `${parsedQty} ${itemUnit} @ ${locName}`,
      itemId,
      { kind: 'stock', itemId, locationId, qty: parsedQty, mode, unit: itemUnit },
    );

    // Clear item+qty; keep location sticky
    setSelectedItemOpt(null);
    setQty('');
  }

  return (
    <View style={s.container}>
      <FieldLabel>Location</FieldLabel>
      <LocationShelfPicker
        locationValue={selectedLocation}
        shelfValue={shelfValue}
        onChangeLocation={opt => {
          setSelectedLocation(opt);
          if (error) setError('');
        }}
        onChangeShelf={setShelfValue}
      />

      <FieldLabel>Item</FieldLabel>
      <SearchablePicker
        placeholder="Search items..."
        searchFn={itemSearch}
        value={selectedItemOpt}
        onSelect={opt => {
          setSelectedItemOpt(prev => prev?.id === opt.id ? null : opt);
          if (error) setError('');
        }}
      />

      <FieldLabel>Mode</FieldLabel>
      <View style={s.chipRow}>
        <FilterChip
          label="Delta (add/remove)"
          active={mode === 'delta'}
          onPress={() => { setMode('delta'); if (error) setError(''); }}
        />
        {/* Recount is a server-gated check-in; only offer it to roles that can
            actually complete it, otherwise the save is silently rejected. */}
        {canRecount && (
          <FilterChip
            label="Set exact (recount)"
            active={mode === 'set'}
            onPress={() => { setMode('set'); if (error) setError(''); }}
          />
        )}
      </View>

      {mode === 'set' && currentOnHand !== null && (
        <Text style={s.hint}>Currently {currentOnHand} on hand</Text>
      )}

      <TextInput
        ref={qtyRef}
        style={[s.input, !!error && s.inputError]}
        placeholder={mode === 'set' ? 'New quantity *' : 'Quantity *'}
        placeholderTextColor={t.colors.textMuted}
        value={qty}
        onChangeText={t => { setQty(t); if (error) setError(''); }}
        keyboardType="decimal-pad"
        returnKeyType="done"
        onSubmitEditing={handleSave}
      />
      {!!error && <Text style={s.errorText}>{error}</Text>}

      <PrimaryButton
        label="Save & add another"
        onPress={handleSave}
        disabled={locked}
        style={{ marginTop: t.spacing.md }}
      />
      {locked && <MaintenanceBanner />}
      <TouchableOpacity style={s.doneBtn} onPress={() => router.back()}>
        <Text style={s.doneBtnText}>Done</Text>
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { gap: 10 },
  input: {
    backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base, height: 44, fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary,
  },
  inputError: { borderColor: t.colors.danger },
  errorText: { fontSize: t.typography.fontSizes.caption, color: t.colors.danger, marginTop: -4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary, marginTop: -4 },
  doneBtn: { alignItems: 'center', paddingVertical: t.spacing.md },
  doneBtnText: { color: t.colors.textSecondary, fontSize: t.typography.fontSizes.md, fontWeight: '600' },
});
