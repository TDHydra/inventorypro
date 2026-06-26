import { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { searchItems, adjustStock, getStockQuantity } from '../../db/queries/items';
import { getAllLocations } from '../../db/queries/locations';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';

interface Props {
  onSaved: (label: string) => void;
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

  const allItems = useMemo(() => searchItems('', 100), []);
  const itemOptions: PickerOption[] = useMemo(
    () => allItems.map(i => ({ id: i.id, label: i.name, sublabel: i.unit })),
    [allItems],
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
    const fullItem = allItems.find(i => i.id === itemId);
    const itemUnit = fullItem?.unit ?? 'each';

    adjustStock(itemId, locationId, parsedQty);
    const abs = getStockQuantity(itemId, locationId);

    appendOutbox('UPDATE', 'stock_by_location', {
      item_id: itemId,
      location_id: locationId,
      quantity: abs,
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
    onSaved(`${parsedQty} ${itemUnit} @ ${locName}`);

    // Clear item+qty; keep location sticky
    setSelectedItemOpt(null);
    setQty('');
  }

  return (
    <View style={s.container}>
      <Text style={s.label}>Location</Text>
      <SearchablePicker
        placeholder="Search locations..."
        options={locationOptions}
        value={selectedLocation}
        onSelect={opt => {
          setSelectedLocation(prev => prev?.id === opt.id ? null : opt);
          if (error) setError('');
        }}
      />

      <Text style={s.label}>Item</Text>
      <SearchablePicker
        placeholder="Search items..."
        options={itemOptions}
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
        placeholderTextColor="#94A3B8"
        value={qty}
        onChangeText={t => { setQty(t); if (error) setError(''); }}
        keyboardType="decimal-pad"
        returnKeyType="done"
        onSubmitEditing={handleSave}
      />
      {!!error && <Text style={s.errorText}>{error}</Text>}

      <TouchableOpacity style={s.btn} onPress={handleSave} disabled={locked}>
        <Text style={s.btnText}>Save &amp; add another</Text>
      </TouchableOpacity>
      {locked && <Text style={{ color: '#B45309', marginTop: 8 }}>Read-only during maintenance</Text>}
      <TouchableOpacity style={s.doneBtn} onPress={() => router.back()}>
        <Text style={s.doneBtnText}>Done</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create({
  container: { gap: 10 },
  input: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, height: 44, fontSize: 14, color: '#1E293B',
  },
  inputError: { borderColor: '#EF4444' },
  errorText: { fontSize: 12, color: '#EF4444', marginTop: -4 },
  label: {
    fontSize: 12, fontWeight: '700', color: '#64748B',
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4,
  },
  btn: {
    backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 13,
    alignItems: 'center', marginTop: 12,
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  doneBtn: { alignItems: 'center', paddingVertical: 12 },
  doneBtnText: { color: '#64748B', fontSize: 15, fontWeight: '600' },
});
