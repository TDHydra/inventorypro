import { useState, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { generateUUID } from '../../../src/utils/uuid';
import { upsertItem, getItemByBarcode, getDistinctValues } from '../../../src/db/queries/items';
import { appendOutbox } from '../../../src/sync/outbox';
import { UnitCategory, UNIT_OPTIONS } from '../../../src/constants/units';
import { BarcodeInput } from '../../../src/components/BarcodeInput';
import { SuggestInput } from '../../../src/components/SuggestInput';

const CATEGORIES: { value: UnitCategory; label: string }[] = [
  { value: 'liquid', label: 'Liquid (gallons, pints...)' },
  { value: 'piece', label: 'Piece (each, box, PPE...)' },
  { value: 'length', label: 'Length (ft, m...)' },
  { value: 'weight', label: 'Weight (lb, kg...)' },
];

const EMPTY = {
  name: '', barcode: '', description: '', sku: '', supplier: '', model: '',
  minAlert: '0', reorderTo: '',
};

export default function AddItemScreen() {
  const router = useRouter();
  const { barcode: initialBarcode } = useLocalSearchParams<{ barcode?: string }>();

  const [name, setName] = useState(EMPTY.name);
  const [barcode, setBarcode] = useState(initialBarcode ?? EMPTY.barcode);
  const [description, setDescription] = useState(EMPTY.description);
  const [sku, setSku] = useState(EMPTY.sku);
  const [supplier, setSupplier] = useState(EMPTY.supplier);
  const [model, setModel] = useState(EMPTY.model);
  const [category, setCategory] = useState<UnitCategory>('piece');
  const [unit, setUnit] = useState('each');
  const [minAlert, setMinAlert] = useState(EMPTY.minAlert);
  const [reorderTo, setReorderTo] = useState(EMPTY.reorderTo);

  // Suggestion pools pulled once from existing catalog data.
  const supplierOptions = useMemo(() => getDistinctValues('supplier'), []);
  const modelOptions = useMemo(() => getDistinctValues('model'), []);

  // Live duplicate-barcode check so crews don't create a second copy.
  const duplicate = useMemo(() => {
    const code = barcode.trim();
    return code ? getItemByBarcode(code) : null;
  }, [barcode]);

  function clearForm() {
    setName(EMPTY.name); setBarcode(EMPTY.barcode); setDescription(EMPTY.description);
    setSku(EMPTY.sku); setSupplier(EMPTY.supplier); setModel(EMPTY.model);
    setCategory('piece'); setUnit('each'); setMinAlert(EMPTY.minAlert); setReorderTo(EMPTY.reorderTo);
  }

  function handleSave() {
    if (!name.trim()) { Alert.alert('Required', 'Item name is required.'); return; }
    if (duplicate) {
      Alert.alert(
        'Barcode already used',
        `"${duplicate.name}" already has this barcode. Open it instead of creating a duplicate?`,
        [
          { text: 'Keep editing', style: 'cancel' },
          { text: 'Open existing', onPress: () => router.replace({ pathname: '/(app)/(inventory)/[id]', params: { id: duplicate.id } }) },
        ]
      );
      return;
    }

    const id = generateUUID();
    const now = new Date().toISOString();
    const trimmed = name.trim();
    const minAlertNum = parseFloat(minAlert) || 0;
    const reorderNum = reorderTo.trim() ? parseFloat(reorderTo) : null;

    const payload = {
      id, name: trimmed,
      barcode: barcode.trim() || null,
      description: description.trim() || null,
      sku: sku.trim() || null,
      supplier: supplier.trim() || null,
      model: model.trim() || null,
      unit_category: category, unit,
      min_qty_alert: minAlertNum,
      reorder_to: reorderNum,
    };
    upsertItem({ ...payload, active: 1, updated_at: now, synced_at: null });
    appendOutbox('INSERT', 'inventory_items', { ...payload, active: true, updated_at: now });
    Alert.alert('Item Added', `${trimmed} added to catalog.`, [{ text: 'OK', onPress: () => router.back() }]);
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Add Item', headerShown: true }} />
      <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          <Text style={s.label}>Basics</Text>
          <TextInput style={s.input} placeholder="Item name *" placeholderTextColor="#94A3B8" value={name} onChangeText={setName} autoFocus />
          <TextInput
            style={[s.input, s.multiline]} placeholder="Description (what it is, where it's used...)"
            placeholderTextColor="#94A3B8" value={description} onChangeText={setDescription}
            multiline numberOfLines={3}
          />
          <SuggestInput label="" value={model} onChange={setModel} suggestions={modelOptions} placeholder="Color / Model (e.g. 'Blue', 'LGR 7000')" />

          <Text style={s.label}>Identifiers</Text>
          <BarcodeInput
            value={barcode}
            onChange={setBarcode}
            placeholder="Barcode (optional)"
            note={duplicate ? `Already in catalog: ${duplicate.name}` : undefined}
            noteTone="warn"
          />
          <TextInput style={s.input} placeholder="SKU / Part # (optional)" placeholderTextColor="#94A3B8" value={sku} onChangeText={setSku} autoCapitalize="characters" />
          <SuggestInput value={supplier} onChange={setSupplier} suggestions={supplierOptions} placeholder="Supplier / Vendor (optional)" />

          <Text style={s.label}>Units</Text>
          {CATEGORIES.map(c => (
            <TouchableOpacity key={c.value} style={[s.opt, category === c.value && s.optActive]} onPress={() => { setCategory(c.value); setUnit(UNIT_OPTIONS[c.value][0]); }}>
              <Text style={[s.optText, category === c.value && s.optTextActive]}>{c.label}</Text>
            </TouchableOpacity>
          ))}
          <View style={s.unitRow}>
            {UNIT_OPTIONS[category].map(u => (
              <TouchableOpacity key={u} style={[s.chip, unit === u && s.chipActive]} onPress={() => setUnit(u)}>
                <Text style={[s.chipText, unit === u && s.chipTextActive]}>{u}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={s.label}>Stock thresholds</Text>
          <TextInput style={s.input} placeholder="Low-stock alert (0 = off)" placeholderTextColor="#94A3B8" value={minAlert} onChangeText={setMinAlert} keyboardType="decimal-pad" />
          <TextInput style={s.input} placeholder="Reorder up to (optional)" placeholderTextColor="#94A3B8" value={reorderTo} onChangeText={setReorderTo} keyboardType="decimal-pad" />

          <TouchableOpacity style={s.btn} onPress={handleSave}>
            <Text style={s.btnText}>Save Item</Text>
          </TouchableOpacity>
          <View style={s.secondaryRow}>
            <TouchableOpacity style={s.linkBtn} onPress={clearForm}>
              <Text style={s.linkText}>Clear</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.linkBtn} onPress={() => router.back()}>
              <Text style={[s.linkText, s.cancelText]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF' },
  content: { padding: 16, gap: 10, paddingBottom: 48 },
  input: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 14, height: 44, fontSize: 14, color: '#1E293B' },
  multiline: { height: 80, paddingTop: 12, textAlignVertical: 'top' },
  label: { fontSize: 12, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 12 },
  opt: { backgroundColor: '#F1F5F9', borderRadius: 8, padding: 10 },
  optActive: { backgroundColor: '#DBEAFE' },
  optText: { fontSize: 14, color: '#475569' },
  optTextActive: { color: '#1D4ED8', fontWeight: '600' },
  unitRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  chip: { backgroundColor: '#F1F5F9', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: '#DBEAFE' },
  chipText: { fontSize: 13, color: '#475569' },
  chipTextActive: { color: '#1D4ED8', fontWeight: '600' },
  btn: { backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 20 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 12 },
  linkBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  linkText: { color: '#2563EB', fontSize: 15, fontWeight: '600' },
  cancelText: { color: '#94A3B8' },
});
