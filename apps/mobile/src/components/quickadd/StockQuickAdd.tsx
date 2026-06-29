import { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { searchItems, adjustStock, getItemById } from '../../db/queries/items';
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
import { MaintenanceBanner } from '../ui/MaintenanceBanner';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

export default function StockQuickAdd({ onSaved }: Props) {
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const qtyRef = useRef<TextInput>(null);

  const [selectedLocation, setSelectedLocation] = useState<PickerOption | null>(null); // sticky
  const [selectedItemOpt, setSelectedItemOpt] = useState<PickerOption | null>(null);
  const [qty, setQty] = useState('');
  const [error, setError] = useState('');

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
    if (!qty.trim() || isNaN(parsedQty) || parsedQty <= 0) {
      setError('Quantity must be greater than 0.');
      return;
    }
    setError('');

    const itemId = selectedItemOpt.id;
    const locationId = selectedLocation.id;
    const now = new Date().toISOString();
    const fullItem = getItemById(itemId);
    const itemUnit = fullItem?.unit ?? 'each';

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

    const locName = selectedLocation.label;
    onSaved(`${parsedQty} ${itemUnit} @ ${locName}`, itemId);

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

      <TextInput
        ref={qtyRef}
        style={[s.input, !!error && s.inputError]}
        placeholder="Quantity *"
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
  doneBtn: { alignItems: 'center', paddingVertical: spacing.md },
  doneBtnText: { color: colors.textSecondary, fontSize: fontSizes.md, fontWeight: '600' },
});
