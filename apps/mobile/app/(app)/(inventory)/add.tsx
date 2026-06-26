import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, Alert, KeyboardAvoidingView, Platform, Switch,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { generateUUID } from '../../../src/utils/uuid';
import {
  upsertItem, getItemByBarcode, getDistinctValues, searchItems,
  adjustStock, getStockQuantity,
} from '../../../src/db/queries/items';
import type { InventoryItem } from '../../../src/db/queries/items';
import { getAllLocations } from '../../../src/db/queries/locations';
import { appendLog } from '../../../src/db/queries/log';
import { appendOutbox } from '../../../src/sync/outbox';
import { UnitCategory, UNIT_OPTIONS } from '../../../src/constants/units';
import { BarcodeInput } from '../../../src/components/BarcodeInput';
import { SuggestInput } from '../../../src/components/SuggestInput';
import { SearchablePicker } from '../../../src/components/SearchablePicker';
import type { PickerOption } from '../../../src/components/SearchablePicker';
import { useSession } from '../../../src/hooks/useSession';
import { useCurrentPosition } from '../../../src/hooks/useCurrentPosition';
import { sortByProximity } from '../../../src/location/proximity';
import { LocationSuggestionBanner } from '../../../src/components/LocationSuggestionBanner';

const CATEGORIES: { value: UnitCategory; label: string }[] = [
  { value: 'liquid', label: 'Liquid (gallons, pints...)' },
  { value: 'piece', label: 'Piece (each, box, PPE...)' },
  { value: 'length', label: 'Length (ft, m...)' },
  { value: 'weight', label: 'Weight (lb, kg...)' },
];

export default function AddStockScreen() {
  const router = useRouter();
  const { user } = useSession();
  const { barcode: initialBarcode } = useLocalSearchParams<{ barcode?: string }>();
  const { coords, request } = useCurrentPosition();

  // ── Item selection state ──────────────────────────────────────────────────
  const [selectedItem, setSelectedItem] = useState<PickerOption | null>(null);
  // Full item row for the selected/autofilled item (to read unit, kind, etc.)
  const [autofillItem, setAutofillItem] = useState<InventoryItem | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [barcode, setBarcode] = useState(initialBarcode ?? '');

  // New-item catalog fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<'product' | 'equipment'>('product');
  const [supplier, setSupplier] = useState('');
  const [model, setModel] = useState('');
  const [unitCat, setUnitCat] = useState<UnitCategory>('piece');
  const [unit, setUnit] = useState('each');
  // Item catalog category (free-text, e.g. "Air Movers", "Filters")
  const [category, setCategory] = useState('');
  // Whether this item is expected back via Check In
  const [returnable, setReturnable] = useState(false);
  // Equipment-only: per-unit tracking toggle and optional asset-tag prefix
  const [unitTracked, setUnitTracked] = useState(false);
  const [tagPrefix, setTagPrefix] = useState('');
  const [minAlert, setMinAlert] = useState('0');
  const [reorderTo, setReorderTo] = useState('');

  // ── Location + quantity state ─────────────────────────────────────────────
  const [selectedLocation, setSelectedLocation] = useState<PickerOption | null>(null);
  const [quantity, setQuantity] = useState('');

  // ── Data ──────────────────────────────────────────────────────────────────
  const allItems = useMemo(() => searchItems('', 100), []);
  const itemOptions: PickerOption[] = useMemo(
    () => allItems.map(i => ({ id: i.id, label: i.name, sublabel: i.barcode ?? i.kind })),
    [allItems],
  );

  const allLocations = useMemo(() => getAllLocations(), []);
  const locationById = useMemo(
    () => new Map(allLocations.map(l => [l.id, l])),
    [allLocations],
  );
  // Proximity-sorted locations; re-runs when coords arrive after the async request.
  const sortedLocations = useMemo(
    () => sortByProximity(
      allLocations.map(l => ({ ...l, latitude: l.latitude ?? null, longitude: l.longitude ?? null })),
      coords,
    ),
    [allLocations, coords],
  );
  // First anchored location (non-null distanceM) is the nearest candidate for the banner.
  const nearestLocation = useMemo(
    () => sortedLocations.find(l => l.distanceM != null) ?? null,
    [sortedLocations],
  );
  const locationOptions: PickerOption[] = useMemo(
    () => sortedLocations.map(l => {
      const parentName = l.parent_id ? locationById.get(l.parent_id)?.name : undefined;
      const distLabel = l.distanceM != null ? `~${Math.round(l.distanceM)} m` : undefined;
      const sublabel = [parentName, distLabel].filter(Boolean).join(' · ') || undefined;
      return { id: l.id, label: l.name, sublabel };
    }),
    [sortedLocations, locationById],
  );

  const supplierOptions = useMemo(() => getDistinctValues('supplier'), []);
  const modelOptions = useMemo(() => getDistinctValues('model'), []);
  const categoryOptions = useMemo(() => getDistinctValues('category'), []);

  // ── Position: request once on mount (fire-and-forget; never blocks UI) ────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void request(); }, []);

  // ── Barcode autofill ──────────────────────────────────────────────────────
  useEffect(() => {
    const code = barcode.trim();
    if (!code) {
      setAutofillItem(null);
      return;
    }
    const found = getItemByBarcode(code);
    if (found) {
      setAutofillItem(found);
      setSelectedItem({ id: found.id, label: found.name, sublabel: found.barcode ?? found.kind });
      setIsCreatingNew(false);
    } else {
      setAutofillItem(null);
    }
  }, [barcode]);

  // ── Kind change: lock units for equipment; set returnable default ─────────
  useEffect(() => {
    if (kind === 'equipment') {
      setUnitCat('piece');
      setUnit('each');
      setReturnable(true);
    } else {
      setReturnable(false);
      setUnitTracked(false);
      setTagPrefix('');
    }
  }, [kind]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  function handleItemSelect(opt: PickerOption) {
    if (selectedItem && selectedItem.id === opt.id) {
      // "Change" pressed on the pill — clear selection
      setSelectedItem(null);
      setAutofillItem(null);
      setBarcode('');
      setIsCreatingNew(false);
    } else {
      setSelectedItem(opt);
      const item = allItems.find(i => i.id === opt.id) ?? null;
      setAutofillItem(item);
      setIsCreatingNew(false);
    }
  }

  function handleItemCreate(text: string) {
    setIsCreatingNew(true);
    setSelectedItem(null);
    setAutofillItem(null);
    setName(text);
  }

  function handleLocationSelect(opt: PickerOption) {
    if (selectedLocation && selectedLocation.id === opt.id) {
      setSelectedLocation(null);
    } else {
      setSelectedLocation(opt);
    }
  }

  function clearForm() {
    setSelectedItem(null);
    setAutofillItem(null);
    setIsCreatingNew(false);
    setBarcode('');
    setName(''); setDescription(''); setKind('product');
    setSupplier(''); setModel('');
    setUnitCat('piece'); setUnit('each');
    setCategory(''); setReturnable(false);
    setUnitTracked(false); setTagPrefix('');
    setMinAlert('0'); setReorderTo('');
    setSelectedLocation(null);
    setQuantity('');
  }

  function handleSave() {
    if (!selectedItem && !isCreatingNew) {
      Alert.alert('Required', 'Select an existing item or create a new one.');
      return;
    }
    if (isCreatingNew && !name.trim()) {
      Alert.alert('Required', 'Item name is required.');
      return;
    }
    if (!isUnitTracked && !selectedLocation) {
      Alert.alert('Required', 'Select a location.');
      return;
    }
    const qty = parseFloat(quantity) || 0;
    if (!isUnitTracked && qty <= 0) {
      Alert.alert('Required', 'Enter a quantity greater than 0.');
      return;
    }

    // Existing unit-tracked item: nothing to add here — individual units are managed
    // on the item detail screen. Do NOT create a duplicate catalog item or write stock.
    if (existingUnitTracked) {
      router.push({ pathname: '/(app)/(inventory)/[id]', params: { id: selectedItem!.id } });
      return;
    }

    const now = new Date().toISOString();
    // Unit for the activity log: prefer the existing item's unit, fall back to form state
    const effectiveUnit = autofillItem?.unit ?? unit;

    let itemId: string;
    if (selectedItem) {
      itemId = selectedItem.id;
    } else {
      // Creating a new catalog item
      itemId = generateUUID();
      const payload = {
        id: itemId,
        name: name.trim(),
        barcode: barcode.trim() || null,
        description: description.trim() || null,
        sku: null as string | null,
        supplier: supplier.trim() || null,
        model: model.trim() || null,
        kind,
        category: category.trim() || null,
        returnable: (returnable ? 1 : 0) as number,
        unit_category: unitCat,
        unit,
        min_qty_alert: parseFloat(minAlert) || 0,
        reorder_to: reorderTo.trim() ? parseFloat(reorderTo) : null,
      };
      upsertItem({ ...payload, unit_tracked: unitTracked ? 1 : 0, tag_prefix: tagPrefix.trim() || null, active: 1, updated_at: now, synced_at: null });
      // Outbox: send returnable + unit_tracked as real booleans (Postgres columns are BOOLEAN)
      appendOutbox('INSERT', 'inventory_items', { ...payload, active: true, updated_at: now, returnable, unit_tracked: unitTracked, tag_prefix: tagPrefix.trim() || null });
    }

    // When unit-tracking is enabled for a new equipment item, skip stock adjustment.
    // Units are added individually from the item screen.
    if (isUnitTrackedNew) {
      Alert.alert('Item Created', 'Open the item screen to add individual units.', [
        { text: 'OK', onPress: () => router.back() },
      ]);
      return;
    }

    const locationId = selectedLocation!.id;
    adjustStock(itemId, locationId, qty);
    const newQty = getStockQuantity(itemId, locationId);
    appendOutbox('INSERT', 'stock_by_location', {
      item_id: itemId, location_id: locationId, quantity: newQty, updated_at: now,
    });
    appendLog({
      user_id: user?.id ?? null,
      team_id: null,
      action: 'add_stock',
      entity_type: 'item',
      entity_id: itemId,
      from_location_id: null,
      to_location_id: locationId,
      quantity: qty,
      unit: effectiveUnit,
      job_id: null,
      note: null,
      metadata: null,
      device_id: null,
      latitude: coords?.latitude ?? null,
      longitude: coords?.longitude ?? null,
      location_accuracy: coords?.accuracy ?? null,
    });

    Alert.alert('Stock Added', `+${qty} ${effectiveUnit} added successfully.`, [
      { text: 'OK', onPress: () => router.back() },
    ]);
  }

  const showReadOnly = !isCreatingNew && autofillItem !== null;
  // Equipment new-item with unit tracking: skip location/qty; create catalog entry only
  const isUnitTrackedNew = isCreatingNew && kind === 'equipment' && unitTracked;
  // Existing unit-tracked item (selected via picker or barcode autofill): its on-hand
  // is the count of available units — it must NEVER write stock_by_location.
  const existingUnitTracked = autofillItem?.unit_tracked === 1;
  // Any unit-tracked path (new or existing): hide Location/Quantity, no stock write.
  const isUnitTracked = isUnitTrackedNew || existingUnitTracked;

  return (
    <>
      <Stack.Screen options={{ title: 'Add Stock to Location', headerShown: true }} />
      <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">

          {/* ── ITEM ─────────────────────────────────────────────────────── */}
          <Text style={s.label}>Item</Text>
          <SearchablePicker
            placeholder="Search existing items..."
            options={itemOptions}
            value={selectedItem}
            onSelect={handleItemSelect}
            onCreate={handleItemCreate}
          />
          <BarcodeInput
            value={barcode}
            onChange={setBarcode}
            placeholder="Scan or enter barcode (optional)"
            note={autofillItem ? `Auto-filled: ${autofillItem.name}` : undefined}
            noteTone="info"
          />

          {/* Read-only card shown when an existing item is selected/autofilled */}
          {showReadOnly && autofillItem && (
            <View style={s.readonlyCard}>
              <Text style={s.readonlyName}>{autofillItem.name}</Text>
              <Text style={s.readonlyMeta}>
                {autofillItem.kind}
                {autofillItem.unit ? ` · ${autofillItem.unit}` : ''}
                {autofillItem.supplier ? ` · ${autofillItem.supplier}` : ''}
                {autofillItem.model ? ` · ${autofillItem.model}` : ''}
              </Text>
            </View>
          )}

          {/* Editable catalog fields for new item creation */}
          {isCreatingNew && (
            <>
              <TextInput
                style={s.input}
                placeholder="Item name *"
                placeholderTextColor="#94A3B8"
                value={name}
                onChangeText={setName}
                autoFocus
              />
              <TextInput
                style={[s.input, s.multiline]}
                placeholder="Description (optional)"
                placeholderTextColor="#94A3B8"
                value={description}
                onChangeText={setDescription}
                multiline
                numberOfLines={3}
              />

              <Text style={s.label}>Kind</Text>
              <View style={s.unitRow}>
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

              <SuggestInput
                value={supplier}
                onChange={setSupplier}
                suggestions={supplierOptions}
                placeholder="Supplier / Vendor (optional)"
              />
              <SuggestInput
                label=""
                value={model}
                onChange={setModel}
                suggestions={modelOptions}
                placeholder="Color / Model (optional)"
              />

              <SuggestInput
                label="Category"
                value={category}
                onChange={setCategory}
                suggestions={categoryOptions}
                placeholder="Air Movers, Filters, Equipment Inventory…"
              />

              <View style={s.switchRow}>
                <Text style={s.switchLabel}>Returnable? (expected back via Check In)</Text>
                <Switch value={returnable} onValueChange={setReturnable} />
              </View>

              {kind === 'equipment' && (
                <>
                  <View style={s.switchRow}>
                    <Text style={s.switchLabel}>Track individual units</Text>
                    <Switch value={unitTracked} onValueChange={setUnitTracked} />
                  </View>
                  {unitTracked && (
                    <TextInput
                      style={s.input}
                      placeholder="Tag prefix (AM-, DH-, MSC-…)"
                      placeholderTextColor="#94A3B8"
                      value={tagPrefix}
                      onChangeText={setTagPrefix}
                      autoCapitalize="characters"
                    />
                  )}
                </>
              )}

              <Text style={s.label}>Units</Text>
              {kind === 'equipment' ? (
                <Text style={s.unitReadOnly}>Unit: each (piece)</Text>
              ) : (
                <>
                  {CATEGORIES.map(c => (
                    <TouchableOpacity
                      key={c.value}
                      style={[s.opt, unitCat === c.value && s.optActive]}
                      onPress={() => { setUnitCat(c.value); setUnit(UNIT_OPTIONS[c.value][0]); }}
                    >
                      <Text style={[s.optText, unitCat === c.value && s.optTextActive]}>{c.label}</Text>
                    </TouchableOpacity>
                  ))}
                  <View style={s.unitRow}>
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

              <Text style={s.label}>Stock thresholds</Text>
              <TextInput
                style={s.input}
                placeholder="Low-stock alert (0 = off)"
                placeholderTextColor="#94A3B8"
                value={minAlert}
                onChangeText={setMinAlert}
                keyboardType="decimal-pad"
              />
              <TextInput
                style={s.input}
                placeholder="Reorder up to (optional)"
                placeholderTextColor="#94A3B8"
                value={reorderTo}
                onChangeText={setReorderTo}
                keyboardType="decimal-pad"
              />
            </>
          )}

          {/* ── LOCATION ─────────────────────────────────────────────────── */}
          {!isUnitTracked && (
            <>
              <Text style={s.label}>Location</Text>
              <LocationSuggestionBanner
                name={nearestLocation?.name ?? null}
                distanceM={nearestLocation?.distanceM ?? null}
                onUse={() => nearestLocation && setSelectedLocation({ id: nearestLocation.id, label: nearestLocation.name })}
              />
              <SearchablePicker
                placeholder="Search locations..."
                options={locationOptions}
                value={selectedLocation}
                onSelect={handleLocationSelect}
              />
            </>
          )}

          {/* ── QUANTITY ─────────────────────────────────────────────────── */}
          {!isUnitTracked && (
            <>
              <Text style={s.label}>Quantity to Add</Text>
              <TextInput
                style={s.input}
                placeholder="Enter quantity"
                placeholderTextColor="#94A3B8"
                value={quantity}
                onChangeText={setQuantity}
                keyboardType="decimal-pad"
              />
            </>
          )}

          {/* ── ACTIONS ──────────────────────────────────────────────────── */}
          {isUnitTracked && (
            <View style={s.noteBox}>
              <Text style={s.noteText}>
                {existingUnitTracked
                  ? 'This item tracks individual units. Open the item to add or manage its units.'
                  : 'Save the item, then add its units from the item screen.'}
              </Text>
            </View>
          )}
          <TouchableOpacity style={s.btn} onPress={handleSave}>
            <Text style={s.btnText}>
              {existingUnitTracked ? 'Open item to add units' : isUnitTrackedNew ? 'Save Item' : 'Add Stock'}
            </Text>
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
  input: {
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, height: 44, fontSize: 14, color: '#1E293B',
  },
  multiline: { height: 80, paddingTop: 12, textAlignVertical: 'top' },
  label: {
    fontSize: 12, fontWeight: '700', color: '#64748B',
    textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 12,
  },
  readonlyCard: {
    backgroundColor: '#EFF6FF', borderRadius: 10, borderWidth: 1,
    borderColor: '#BFDBFE', paddingHorizontal: 14, paddingVertical: 10,
  },
  readonlyName: { fontSize: 14, fontWeight: '700', color: '#1E293B' },
  readonlyMeta: { fontSize: 12, color: '#64748B', marginTop: 2 },
  opt: { backgroundColor: '#F1F5F9', borderRadius: 8, padding: 10 },
  optActive: { backgroundColor: '#DBEAFE' },
  optText: { fontSize: 14, color: '#475569' },
  optTextActive: { color: '#1D4ED8', fontWeight: '600' },
  unitRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  chip: { backgroundColor: '#F1F5F9', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: '#DBEAFE' },
  chipText: { fontSize: 13, color: '#475569' },
  chipTextActive: { color: '#1D4ED8', fontWeight: '600' },
  btn: {
    backgroundColor: '#2563EB', borderRadius: 12, paddingVertical: 13,
    alignItems: 'center', marginTop: 20,
  },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  secondaryRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 12 },
  linkBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  linkText: { color: '#2563EB', fontSize: 15, fontWeight: '600' },
  cancelText: { color: '#94A3B8' },
  noteBox: {
    backgroundColor: '#EFF6FF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#BFDBFE',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 4,
  },
  noteText: {
    fontSize: 13,
    color: '#1D4ED8',
    lineHeight: 18,
  },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, paddingVertical: 10,
  },
  switchLabel: { fontSize: 14, color: '#1E293B', flex: 1, marginRight: 12 },
  unitReadOnly: {
    fontSize: 14, color: '#475569', fontStyle: 'italic',
    paddingVertical: 8, paddingHorizontal: 4,
  },
});
