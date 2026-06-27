import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
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
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { colors } from '../../../src/theme';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { AppInput } from '../../../src/components/ui/AppInput';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import { AdvancedFields } from '../../../src/components/ui/AdvancedFields';

const CATEGORIES: { value: UnitCategory; label: string }[] = [
  { value: 'liquid', label: 'Liquid (gallons, pints...)' },
  { value: 'piece', label: 'Piece (each, box, PPE...)' },
  { value: 'length', label: 'Length (ft, m...)' },
  { value: 'weight', label: 'Weight (lb, kg...)' },
];

export default function AddStockScreen() {
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
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

    if (isWriteBlocked()) return;

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
          <FieldLabel>Item</FieldLabel>
          <SearchablePicker
            placeholder="Search existing items..."
            options={itemOptions}
            value={selectedItem}
            onSelect={handleItemSelect}
            onCreate={handleItemCreate}
          />
          <AdvancedFields>
            <BarcodeInput
              value={barcode}
              onChange={setBarcode}
              placeholder="Scan or enter barcode (optional)"
              note={autofillItem ? `Auto-filled: ${autofillItem.name}` : undefined}
              noteTone="info"
            />
          </AdvancedFields>

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
              <AppInput
                placeholder="Item name *"
                value={name}
                onChangeText={setName}
                autoFocus
              />

              <FieldLabel style={{ marginTop: 12 }}>Kind</FieldLabel>
              <View style={s.unitRow}>
                {(['product', 'equipment'] as const).map(k => (
                  <FilterChip
                    key={k}
                    label={k.charAt(0).toUpperCase() + k.slice(1)}
                    active={kind === k}
                    onPress={() => setKind(k)}
                  />
                ))}
              </View>

              {kind === 'equipment' && (
                <>
                  <View style={s.switchRow}>
                    <Text style={s.switchLabel}>Track individual units</Text>
                    <Switch value={unitTracked} onValueChange={setUnitTracked} />
                  </View>
                  {unitTracked && (
                    <AppInput
                      placeholder="Tag prefix (AM-, DH-, MSC-…)"
                      value={tagPrefix}
                      onChangeText={setTagPrefix}
                      autoCapitalize="characters"
                    />
                  )}
                </>
              )}

              <FieldLabel style={{ marginTop: 12 }}>Units</FieldLabel>
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
                      <FilterChip
                        key={u}
                        label={u}
                        active={unit === u}
                        onPress={() => setUnit(u)}
                      />
                    ))}
                  </View>
                </>
              )}

              <AdvancedFields>
                <AppInput
                  style={s.multiline}
                  placeholder="Description (optional)"
                  value={description}
                  onChangeText={setDescription}
                  multiline
                  numberOfLines={3}
                />
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
                <FieldLabel style={{ marginTop: 12 }}>Stock thresholds</FieldLabel>
                <AppInput
                  placeholder="Low-stock alert (0 = off)"
                  value={minAlert}
                  onChangeText={setMinAlert}
                  keyboardType="decimal-pad"
                />
                <AppInput
                  placeholder="Reorder up to (optional)"
                  value={reorderTo}
                  onChangeText={setReorderTo}
                  keyboardType="decimal-pad"
                />
              </AdvancedFields>
            </>
          )}

          {/* ── LOCATION ─────────────────────────────────────────────────── */}
          {!isUnitTracked && (
            <>
              <FieldLabel style={{ marginTop: 12 }}>Location</FieldLabel>
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
              <FieldLabel style={{ marginTop: 12 }}>Quantity to Add</FieldLabel>
              <AppInput
                placeholder="Enter quantity"
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
          {/* The existingUnitTracked branch only navigates (no write), so it
              stays enabled during maintenance — only the writing modes gate. */}
          <PrimaryButton
            label={existingUnitTracked ? 'Open item to add units' : isUnitTrackedNew ? 'Save Item' : 'Add Stock'}
            onPress={handleSave}
            disabled={!existingUnitTracked && locked}
            style={{ marginTop: 20 }}
          />
          {!existingUnitTracked && locked && <MaintenanceBanner />}
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
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 10, paddingBottom: 48 },
  multiline: { height: 80, paddingTop: 12, textAlignVertical: 'top' },
  readonlyCard: {
    backgroundColor: colors.primaryBg, borderRadius: 10, borderWidth: 1,
    borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 10,
  },
  readonlyName: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  readonlyMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  opt: { backgroundColor: '#F1F5F9', borderRadius: 8, padding: 10 },
  optActive: { backgroundColor: colors.primaryBgStrong },
  optText: { fontSize: 14, color: '#475569' },
  optTextActive: { color: colors.primaryText, fontWeight: '600' },
  unitRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  secondaryRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 12 },
  linkBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  linkText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
  cancelText: { color: colors.textMuted },
  noteBox: {
    backgroundColor: colors.primaryBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 4,
  },
  noteText: {
    fontSize: 13,
    color: colors.primaryText,
    lineHeight: 18,
  },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  switchLabel: { fontSize: 14, color: colors.textPrimary, flex: 1, marginRight: 12 },
  unitReadOnly: {
    fontSize: 14, color: '#475569', fontStyle: 'italic',
    paddingVertical: 8, paddingHorizontal: 4,
  },
});
