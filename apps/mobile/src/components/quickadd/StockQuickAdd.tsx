import { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { searchItems, adjustStock, upsertStock, getStockQuantity, getItemById } from '../../db/queries/items';
import { getAllLocations } from '../../db/queries/locations';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { colors, spacing, radii, fontSizes } from '../../theme';
import { PrimaryButton } from '../ui/PrimaryButton';
import { FieldLabel } from '../ui/FieldLabel';
import { FilterChip } from '../ui/FilterChip';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

type Mode = 'delta' | 'set';

export default function StockQuickAdd({ onSaved }: Props) {
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const qtyRef = useRef<TextInput>(null);

  const [selectedLocation, setSelectedLocation] = useState<PickerOption | null>(null); // sticky
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

  const allLocations = useMemo(() => getAllLocations(), []);
  const locationOptions: PickerOption[] = useMemo(
    () => allLocations.map(l => ({ id: l.id, label: l.name })),
    [allLocations],
  );

  // DB-backed search (not a capped pre-load) so the full catalog is reachable.
  const itemSearch = useMemo(
    () => (q: string): PickerOption[] =>
      searchItems(q, 12).map(i => ({ id: i.id, label: i.name, sublabel: i.unit })),
    [],
  );

  function handleSave() {
    if (!selectedLocation) {
      setError('Select a location.');
      return;
    }
    if (!selectedItemOpt) {
      setError('Select an item.');
      return;
    }
    const parsedQty = parseFloat(qty);
    // Delta must be a positive addition; Set is an absolute recount, so 0 is a
    // valid "nothing here" reading — only reject NaN / negative.
    if (!qty.trim() || isNaN(parsedQty) || (mode === 'delta' ? parsedQty <= 0 : parsedQty < 0)) {
      setError(mode === 'delta' ? 'Quantity must be greater than 0.' : 'Quantity must be 0 or greater.');
      return;
    }
    setError('');

    const itemId = selectedItemOpt.id;
    const locationId = selectedLocation.id;
    const now = new Date().toISOString();
    const fullItem = getItemById(itemId);
    const itemUnit = fullItem?.unit ?? 'each';

    if (mode === 'set') {
      // Absolute recount — server clamps ≥0.
      upsertStock({ item_id: itemId, location_id: locationId, quantity: parsedQty, updated_at: now });

      appendOutbox('UPDATE', 'stock_by_location', {
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
    );

    // Clear item+qty; keep location sticky
    setSelectedItemOpt(null);
    setQty('');
  }

  return (
    <View style={s.container}>
      <FieldLabel>Location</FieldLabel>
      <SearchablePicker
        placeholder="Search locations..."
        options={locationOptions}
        value={selectedLocation}
        onSelect={opt => {
          setSelectedLocation(prev => prev?.id === opt.id ? null : opt);
          if (error) setError('');
        }}
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
        <FilterChip
          label="Set exact (recount)"
          active={mode === 'set'}
          onPress={() => { setMode('set'); if (error) setError(''); }}
        />
      </View>

      {mode === 'set' && currentOnHand !== null && (
        <Text style={s.hint}>Currently {currentOnHand} on hand</Text>
      )}

      <TextInput
        ref={qtyRef}
        style={[s.input, !!error && s.inputError]}
        placeholder={mode === 'set' ? 'New quantity *' : 'Quantity *'}
        placeholderTextColor={colors.textMuted}
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
        style={{ marginTop: spacing.md }}
      />
      {locked && <MaintenanceBanner />}
      <TouchableOpacity style={s.doneBtn} onPress={() => router.back()}>
        <Text style={s.doneBtnText}>Done</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { gap: 10 },
  input: {
    backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.base, height: 44, fontSize: fontSizes.body, color: colors.textPrimary,
  },
  inputError: { borderColor: colors.danger },
  errorText: { fontSize: fontSizes.caption, color: colors.danger, marginTop: -4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  hint: { fontSize: fontSizes.caption, color: colors.textSecondary, marginTop: -4 },
  doneBtn: { alignItems: 'center', paddingVertical: spacing.md },
  doneBtnText: { color: colors.textSecondary, fontSize: fontSizes.md, fontWeight: '600' },
});
