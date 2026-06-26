import { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { generateUUID } from '../../utils/uuid';
import { searchItems } from '../../db/queries/items';
import { upsertUnit, getUnitByTag } from '../../db/queries/equipmentUnits';
import type { EquipmentUnit } from '../../db/queries/equipmentUnits';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';

interface Props {
  onSaved: (label: string) => void;
}

export default function EquipmentQuickAdd({ onSaved }: Props) {
  const router = useRouter();
  const { user } = useSession();
  const tagRef = useRef<TextInput>(null);

  const [selectedItem, setSelectedItem] = useState<PickerOption | null>(null); // sticky
  const [assetTag, setAssetTag] = useState('');
  const [serial, setSerial] = useState('');
  const [tagError, setTagError] = useState('');

  const equipmentItems = useMemo(
    () => searchItems('', 100).filter(i => i.unit_tracked === 1),
    [],
  );
  const itemOptions: PickerOption[] = useMemo(
    () => equipmentItems.map(i => ({
      id: i.id,
      label: i.name,
      sublabel: i.tag_prefix ?? undefined,
    })),
    [equipmentItems],
  );

  function handleSave() {
    const tag = assetTag.trim();
    if (!selectedItem) {
      setTagError('Select an item first.');
      return;
    }
    if (!tag) {
      setTagError('Asset tag is required.');
      return;
    }

    // Reject duplicate tag
    const existing = getUnitByTag(tag);
    if (existing !== null) {
      setTagError('Tag already used.');
      return;
    }
    setTagError('');

    const now = new Date().toISOString();
    const id = generateUUID();

    const u: EquipmentUnit = {
      id,
      item_id: selectedItem.id,
      asset_tag: tag,
      serial_number: serial.trim() || null,
      status: 'available',
      current_location_id: null,
      current_job_id: null,
      notes: null,
      created_at: now,
      updated_at: now,
      synced_at: null,
    };

    upsertUnit(u);
    appendOutbox('INSERT', 'equipment_units', { ...u });
    appendLog({
      action: 'add_units',
      entity_type: 'equipment_unit',
      entity_id: id,
      user_id: user?.id ?? null,
      team_id: null,
      note: tag,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      metadata: null,
      device_id: null,
    });

    onSaved(tag);
    setAssetTag(''); // clear tag+serial; keep item sticky
    setSerial('');
    setTimeout(() => tagRef.current?.focus(), 100);
  }

  return (
    <View style={s.container}>
      <Text style={s.label}>Item (unit-tracked)</Text>
      <SearchablePicker
        placeholder="Search tracked items..."
        options={itemOptions}
        value={selectedItem}
        onSelect={opt => {
          setSelectedItem(prev => prev?.id === opt.id ? null : opt);
          if (tagError) setTagError('');
        }}
      />

      <TextInput
        ref={tagRef}
        autoFocus
        style={[s.input, !!tagError && s.inputError]}
        placeholder="Asset tag *"
        placeholderTextColor="#94A3B8"
        value={assetTag}
        onChangeText={t => { setAssetTag(t); if (tagError) setTagError(''); }}
        autoCapitalize="characters"
        returnKeyType="done"
        onSubmitEditing={handleSave}
      />
      {!!tagError && <Text style={s.errorText}>{tagError}</Text>}

      <TextInput
        style={s.input}
        placeholder="Serial number (optional)"
        placeholderTextColor="#94A3B8"
        value={serial}
        onChangeText={setSerial}
      />

      <TouchableOpacity
        style={[s.btn, !selectedItem && s.btnDisabled]}
        onPress={handleSave}
        disabled={!selectedItem}
      >
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
  btn: {
    backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 13,
    alignItems: 'center', marginTop: 12,
  },
  btnDisabled: { backgroundColor: '#93C5FD' },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  doneBtn: { alignItems: 'center', paddingVertical: 12 },
  doneBtnText: { color: '#64748B', fontSize: 15, fontWeight: '600' },
});
