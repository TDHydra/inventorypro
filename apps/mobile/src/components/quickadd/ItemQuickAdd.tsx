import { useState, useRef, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { generateUUID } from '../../utils/uuid';
import { upsertItem } from '../../db/queries/items';
import type { InventoryItem } from '../../db/queries/items';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { UnitCategory, UNIT_OPTIONS } from '../../constants/units';

const DEFAULT_UNIT_CAT: UnitCategory = 'piece';
const DEFAULT_UNIT = 'each';

const CATEGORIES: { value: UnitCategory; label: string }[] = [
  { value: 'piece', label: 'Piece' },
  { value: 'liquid', label: 'Liquid' },
  { value: 'length', label: 'Length' },
  { value: 'weight', label: 'Weight' },
];

interface Props {
  onSaved: (label: string) => void;
}

export default function ItemQuickAdd({ onSaved }: Props) {
  const router = useRouter();
  const { user } = useSession();
  const nameRef = useRef<TextInput>(null);

  const [name, setName] = useState('');
  const [kind, setKind] = useState<'product' | 'equipment'>('product');
  const [unitCat, setUnitCat] = useState<UnitCategory>(DEFAULT_UNIT_CAT);
  const [unit, setUnit] = useState(DEFAULT_UNIT);
  const [category, setCategory] = useState('');
  const [unitTracked, setUnitTracked] = useState(false);
  const [tagPrefix, setTagPrefix] = useState('');
  const [nameError, setNameError] = useState('');

  // When kind changes: lock unit for equipment; reset equipment fields for product
  useEffect(() => {
    if (kind === 'equipment') {
      setUnitCat('piece');
      setUnit('each');
    } else {
      setUnitTracked(false);
      setTagPrefix('');
    }
  }, [kind]);

  function clearForm() {
    setName('');
    setKind('product');
    setUnitCat(DEFAULT_UNIT_CAT);
    setUnit(DEFAULT_UNIT);
    setCategory('');
    setUnitTracked(false);
    setTagPrefix('');
    setNameError('');
  }

  function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Name is required.');
      return;
    }
    setNameError('');

    const now = new Date().toISOString();
    const id = generateUUID();
    const isEquipment = kind === 'equipment';

    const item: InventoryItem = {
      id,
      name: trimmedName,
      barcode: null,
      description: null,
      sku: null,
      supplier: null,
      model: null,
      kind,
      category: category.trim() || null,
      returnable: 0,
      unit_tracked: isEquipment && unitTracked ? 1 : 0,
      tag_prefix: tagPrefix.trim() || null,
      unit_category: unitCat,
      unit,
      min_qty_alert: 0,
      reorder_to: null,
      active: 1,
      updated_at: now,
      synced_at: null,
    };

    upsertItem(item);
    // synced_at is a local-only column — the server table has none, and the
    // dynamic push INSERT would error on it. Strip it from the outbox payload.
    const { synced_at: _s, ...itemRow } = item;
    appendOutbox('INSERT', 'inventory_items', {
      ...itemRow,
      returnable: !!item.returnable,
      unit_tracked: !!item.unit_tracked,
      active: true,
    });
    appendLog({
      action: 'item_created',
      entity_type: 'item',
      entity_id: id,
      user_id: user?.id ?? null,
      team_id: null,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      note: trimmedName,
      metadata: null,
      device_id: null,
    });

    onSaved(trimmedName);
    clearForm();
    setTimeout(() => nameRef.current?.focus(), 100);
  }

  return (
    <View style={s.container}>
      <TextInput
        ref={nameRef}
        style={[s.input, !!nameError && s.inputError]}
        placeholder="Item name *"
        placeholderTextColor="#94A3B8"
        value={name}
        onChangeText={t => { setName(t); if (nameError) setNameError(''); }}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={handleSave}
      />
      {!!nameError && <Text style={s.errorText}>{nameError}</Text>}

      <Text style={s.label}>Kind</Text>
      <View style={s.chipRow}>
        {(['product', 'equipment'] as const).map(k => (
          <TouchableOpacity
            key={k}
            style={[s.chip, kind === k && s.chipActive]}
            onPress={() => setKind(k)}
          >
            <Text style={[s.chipText, kind === k && s.chipTextActive]}>
              {k.charAt(0).toUpperCase() + k.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {kind === 'equipment' ? (
        <View style={s.unitReadOnlyRow}>
          <Text style={s.unitReadOnly}>Unit: each (piece)</Text>
        </View>
      ) : (
        <>
          <Text style={s.label}>Unit category</Text>
          <View style={s.chipRow}>
            {CATEGORIES.map(c => (
              <TouchableOpacity
                key={c.value}
                style={[s.chip, unitCat === c.value && s.chipActive]}
                onPress={() => { setUnitCat(c.value); setUnit(UNIT_OPTIONS[c.value][0]); }}
              >
                <Text style={[s.chipText, unitCat === c.value && s.chipTextActive]}>{c.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={s.chipRow}>
            {UNIT_OPTIONS[unitCat].map(u => (
              <TouchableOpacity
                key={u}
                style={[s.chip, unit === u && s.chipActive]}
                onPress={() => setUnit(u)}
              >
                <Text style={[s.chipText, unit === u && s.chipTextActive]}>{u}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </>
      )}

      <TextInput
        style={s.input}
        placeholder="Category (optional)"
        placeholderTextColor="#94A3B8"
        value={category}
        onChangeText={setCategory}
      />

      {kind === 'equipment' && (
        <>
          <View style={s.switchRow}>
            <Text style={s.switchLabel}>Track individual units</Text>
            <Switch value={unitTracked} onValueChange={setUnitTracked} />
          </View>
          {unitTracked && (
            <TextInput
              style={s.input}
              placeholder="Tag prefix (e.g. AM-, DH-)"
              placeholderTextColor="#94A3B8"
              value={tagPrefix}
              onChangeText={setTagPrefix}
              autoCapitalize="characters"
            />
          )}
        </>
      )}

      <TouchableOpacity style={s.btn} onPress={handleSave}>
        <Text style={s.btnText}>Save &amp; add another</Text>
      </TouchableOpacity>
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { backgroundColor: '#F1F5F9', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: '#DBEAFE' },
  chipText: { fontSize: 13, color: '#475569' },
  chipTextActive: { color: '#1D4ED8', fontWeight: '600' },
  unitReadOnlyRow: { paddingVertical: 4 },
  unitReadOnly: { fontSize: 14, color: '#475569', fontStyle: 'italic' },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, paddingVertical: 10,
  },
  switchLabel: { fontSize: 14, color: '#1E293B', flex: 1, marginRight: 12 },
  btn: {
    backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 13,
    alignItems: 'center', marginTop: 12,
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  doneBtn: { alignItems: 'center', paddingVertical: 12 },
  doneBtnText: { color: '#64748B', fontSize: 15, fontWeight: '600' },
});
