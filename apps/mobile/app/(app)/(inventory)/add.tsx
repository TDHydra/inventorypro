import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Switch } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { generateUUID } from '../../../src/utils/uuid';
import {
  upsertItem, getItemByBarcode, getDistinctValues, searchItems, getItemById,
  adjustStock, getStockQuantity,
} from '../../../src/db/queries/items';
import type { InventoryItem } from '../../../src/db/queries/items';
import { getAllLocations, getLocationPath, getShelfLocations, getShelvesForParent, findOrCreateShelf, findOrCreateShelfByName } from '../../../src/db/queries/locations';
import { appendLog } from '../../../src/db/queries/log';
import { appendOutbox } from '../../../src/sync/outbox';
import { getItemTypes, parseItemTypeMeta } from '../../../src/db/queries/taxonomy';
import { PRODUCT_CLASS_IDS, getUnitsForClass } from '../../../src/constants/units';
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
import { runInTransaction } from '../../../src/db/tx';
import { parseQuantity, parseOptionalCount, parsePackSize } from '../../../src/lib/validation';
import { colors } from '../../../src/theme';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { AppInput } from '../../../src/components/ui/AppInput';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import { AdvancedFields } from '../../../src/components/ui/AdvancedFields';
import { HidableField } from '../../../src/components/ui/HidableField';

export default function AddStockScreen() {
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const { barcode: initialBarcode, locationId: initialLocationId } =
    useLocalSearchParams<{ barcode?: string; locationId?: string }>();
  const { coords, request } = useCurrentPosition();

  // Admin-managed Item Type taxonomy (PPE, Filters, …). Each carries its units +
  // unit class in meta. Selecting a type drives the unit class, unit options, and
  // the item's catalog category (mirrors quick-add). Equipment is NOT here.
  const itemTypes = useMemo(() => getItemTypes(), []);
  // Pieces class id — the default unit class when no item type is selected.
  const CLASS_PIECE_ID = PRODUCT_CLASS_IDS.piece;

  // ── Item selection state ──────────────────────────────────────────────────
  const [selectedItem, setSelectedItem] = useState<PickerOption | null>(null);
  // Full item row for the selected/autofilled item (to read unit, kind, etc.)
  const [autofillItem, setAutofillItem] = useState<InventoryItem | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [barcode, setBarcode] = useState(initialBarcode ?? '');

  // New-item catalog fields
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [supplier, setSupplier] = useState('');
  const [model, setModel] = useState('');
  // Selected item_category label → becomes the item's catalog category.
  const [itemType, setItemType] = useState<string>('');
  // unit_category stores a product_class id (drives formatQuantity decimals).
  const [unitCat, setUnitCat] = useState<string>(CLASS_PIECE_ID);
  const [unit, setUnit] = useState<string>(getUnitsForClass(CLASS_PIECE_ID)[0] ?? 'each');
  // Whether this item is expected back via Check In
  const [returnable, setReturnable] = useState(false);
  const [minAlert, setMinAlert] = useState('0');
  const [reorderTo, setReorderTo] = useState('');
  // Optional "home" location for a newly-created item (where it belongs). Nullable.
  // Distinct from the add-stock target location below.
  const [homeLocation, setHomeLocation] = useState<PickerOption | null>(null);

  // ── Location + quantity state ─────────────────────────────────────────────
  const [selectedLocation, setSelectedLocation] = useState<PickerOption | null>(null);
  const [shelfValue, setShelfValue] = useState<PickerOption | null>(null); // shelf within the location
  const [quantity, setQuantity] = useState('');
  const [packSize, setPackSize] = useState(''); // new item: units per pack
  const [packMode, setPackMode] = useState<'packs' | 'units'>('packs');

  // ── Data ──────────────────────────────────────────────────────────────────
  // DB-backed product search (not a capped pre-load) so the full catalog is
  // reachable; kind='product' filtered IN-SQL.
  const itemSearch = useMemo(
    () => (q: string): PickerOption[] =>
      searchItems(q, 12, 0, undefined, 'product').map(i => ({ id: i.id, label: i.name, sublabel: i.barcode ?? i.kind })),
    [],
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
  // Home-location typeahead over Shelf-type locations (named WH-A1, SHOP-B3, …).
  // Falls back to the full breadcrumb list when no shelves exist yet so the field
  // stays usable. Shelves span every parent here (not scoped to one location like
  // the add-stock Shelf field below), so each option shows its parent as a
  // sublabel — otherwise two shelves named the same (e.g. "A1" in two rooms)
  // would be indistinguishable.
  const homeLocationOptions: PickerOption[] = useMemo(() => {
    const shelves = getShelfLocations();
    return shelves.length
      ? shelves.map(s => ({
          id: s.id,
          label: s.name,
          sublabel: s.parent_id ? locationById.get(s.parent_id)?.name : undefined,
        }))
      : allLocations.map(l => ({ id: l.id, label: getLocationPath(l.id) }));
  }, [allLocations, locationById]);

  // Units available for the current selection: the selected item type's curated
  // list, falling back to the unit class's units (or piece) when none/empty.
  const selectedType = itemTypes.find(t => t.label === itemType) ?? null;
  const typeUnits = selectedType ? parseItemTypeMeta(selectedType.meta).units : [];
  const unitOptions = typeUnits.length > 0 ? typeUnits : getUnitsForClass(unitCat);

  const supplierOptions = useMemo(() => getDistinctValues('supplier'), []);
  const modelOptions = useMemo(() => getDistinctValues('model'), []);

  // Pick/clear an item type — selecting one auto-sets the units + unit class +
  // catalog category to whatever that type allows (mirrors quick-add).
  function selectItemType(t: { label: string; meta: string | null }) {
    if (itemType === t.label) {
      // Tap again to clear → back to the default piece class + units.
      setItemType('');
      setUnitCat(CLASS_PIECE_ID);
      setUnit(getUnitsForClass(CLASS_PIECE_ID)[0] ?? 'each');
      return;
    }
    const m = parseItemTypeMeta(t.meta);
    const cls = m.classId ?? CLASS_PIECE_ID;
    const opts = m.units.length > 0 ? m.units : getUnitsForClass(cls);
    setItemType(t.label);
    setUnitCat(cls);
    setUnit(opts[0] ?? '');
  }

  // ── Position: request once on mount (fire-and-forget; never blocks UI) ────
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void request(); }, []);

  // ── "Add stock here": pre-select the add-stock target from the locationId
  // route param (set when arriving from a location detail screen). Runs once the
  // param/location map is available; the normal (no-param) flow is untouched.
  useEffect(() => {
    if (!initialLocationId) return;
    const loc = locationById.get(initialLocationId);
    if (loc) setSelectedLocation({ id: loc.id, label: loc.name });
  }, [initialLocationId, locationById]);

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
      const item = getItemById(opt.id);
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
    setShelfValue(null); // shelf is per-location — reset when the location changes
    if (selectedLocation && selectedLocation.id === opt.id) {
      setSelectedLocation(null);
    } else {
      setSelectedLocation(opt);
    }
  }

  // The selected location's "has shelves" flag drives the Shelf field.
  const selectedLocFull = selectedLocation ? locationById.get(selectedLocation.id) : undefined;
  const locationHasShelves = selectedLocFull?.has_shelves === 1;
  const shelfOptions: PickerOption[] = useMemo(
    () => (locationHasShelves && selectedLocation)
      ? getShelvesForParent(selectedLocation.id).map(s => ({ id: s.id, label: s.name }))
      : [],
    [locationHasShelves, selectedLocation],
  );

  function clearForm() {
    setSelectedItem(null);
    setAutofillItem(null);
    setIsCreatingNew(false);
    setBarcode('');
    setName(''); setDescription('');
    setSupplier(''); setModel('');
    setItemType('');
    setUnitCat(CLASS_PIECE_ID); setUnit(getUnitsForClass(CLASS_PIECE_ID)[0] ?? 'each');
    setReturnable(false);
    setMinAlert('0'); setReorderTo('');
    setHomeLocation(null);
    setSelectedLocation(null);
    setShelfValue(null);
    setQuantity('');
    setPackSize('');
    setPackMode('packs');
  }

  // Pack size in play for the current add: an existing item's stored pack_size,
  // or (when creating) the entered value. >1 means the Packs/Units toggle applies.
  const newItemPackSize = (() => {
    // Render-safe: parsePackSize rejects negatives / ≤1 / non-integers and blanks
    // to null. Invalid entries surface a precise error in handleSave (no Alert here).
    const r = parsePackSize(packSize);
    return r.ok ? r.value : null;
  })();
  const effectivePackSize = selectedItem
    ? (autofillItem?.pack_size ?? null)
    : (isCreatingNew ? newItemPackSize : null);
  const usePacks = !!effectivePackSize && effectivePackSize > 1 && packMode === 'packs';

  function handleSave() {
    if (!selectedItem && !isCreatingNew) {
      Alert.alert('Required', 'Select an existing item or create a new one.');
      return;
    }
    if (isCreatingNew && !name.trim()) {
      Alert.alert('Required', 'Item name is required.');
      return;
    }

    // Existing unit-tracked item: nothing to add here — individual units are managed
    // on the item detail screen. Do NOT create a duplicate catalog item or write stock.
    if (existingUnitTracked) {
      router.push({ pathname: '/(app)/(inventory)/[id]', params: { id: selectedItem!.id } });
      return;
    }

    if (!selectedLocation) {
      Alert.alert('Required', 'Select a location.');
      return;
    }

    // Validate the new-item numeric fields up front (precise, fixable errors).
    let validatedPackSize: number | null = null;
    let validatedMinAlert = 0;
    let validatedReorderTo: number | null = null;
    if (isCreatingNew) {
      const packRes = parsePackSize(packSize);
      if (!packRes.ok) {
        Alert.alert('Invalid pack size', packRes.error);
        return;
      }
      validatedPackSize = packRes.value;

      const minAlertRes = parseOptionalCount(minAlert, 'Low-stock alert');
      if (!minAlertRes.ok) {
        Alert.alert('Invalid low-stock alert', minAlertRes.error);
        return;
      }
      validatedMinAlert = minAlertRes.value ?? 0;

      const reorderRes = parseOptionalCount(reorderTo, 'Reorder up to');
      if (!reorderRes.ok) {
        Alert.alert('Invalid reorder amount', reorderRes.error);
        return;
      }
      validatedReorderTo = reorderRes.value;
    }

    // Entered value is packs or base units depending on the toggle; stock is
    // always written in BASE units (entered × pack_size when adding packs).
    const qtyRes = parseQuantity(quantity);
    if (!qtyRes.ok) {
      Alert.alert('Invalid quantity', qtyRes.error);
      return;
    }
    const entered = qtyRes.value;
    const qty = usePacks ? entered * (effectivePackSize as number) : entered;

    if (isWriteBlocked()) {
      Alert.alert('Maintenance', 'Writes are paused for maintenance. Try again shortly.');
      return;
    }

    const now = new Date().toISOString();
    // Unit for the activity log: prefer the existing item's unit, fall back to form state
    const effectiveUnit = autofillItem?.unit ?? unit;

    // Atomic: optional new-item create + stock adjust + outbox + log all land
    // together or roll back, so a mid-flow failure can't leave orphaned/lost stock.
    try {
      runInTransaction(() => {
        let itemId: string;
        if (selectedItem) {
          itemId = selectedItem.id;
        } else {
          // Creating a new catalog item
          itemId = generateUUID();
          // Resolve a freshly-typed home-location shelf up front. findOrCreateShelfByName
          // SWALLOWS write failures and returns null, so leaving it inline (unchecked)
          // would silently drop the home location AND — if the outbox enqueue threw
          // after the shelf row was inserted in this same transaction — commit an
          // orphaned shelf with no outbox entry. Mirror the stock-shelf guard at :369:
          // null on a '__new__' label means the create failed, so abort and roll back.
          let homeLocationId: string | null;
          if (homeLocation?.id === '__new__') {
            homeLocationId = findOrCreateShelfByName(homeLocation.label);
            if (!homeLocationId) {
              throw new Error('Could not create the home location shelf. Please re-pick or re-enter it.');
            }
          } else {
            homeLocationId = homeLocation?.id ?? null;
          }
          const payload = {
            id: itemId,
            name: name.trim(),
            barcode: barcode.trim() || null,
            description: description.trim() || null,
            sku: null as string | null,
            supplier: supplier.trim() || null,
            model: model.trim() || null,
            kind: 'product' as const,
            category: itemType || null,
            returnable: (returnable ? 1 : 0) as number,
            unit_category: unitCat,
            unit,
            min_qty_alert: validatedMinAlert,
            reorder_to: validatedReorderTo,
            home_location_id: homeLocationId,
            pack_size: validatedPackSize,
          };
          upsertItem({ ...payload, unit_tracked: 0, tag_prefix: null, active: 1, updated_at: now, synced_at: null });
          // Outbox: send returnable as real boolean (Postgres column is BOOLEAN)
          appendOutbox('INSERT', 'inventory_items', { ...payload, active: true, updated_at: now, returnable, unit_tracked: false, tag_prefix: null });
        }

        // If the location has shelves and one was chosen/typed, stock goes to that
        // shelf (a child location, find-or-created). Otherwise to the location itself.
        const locationId = (locationHasShelves && shelfValue?.label)
          ? findOrCreateShelf(selectedLocation!.id, shelfValue.label)
          : selectedLocation!.id;
        if (!locationId) {
          // Shelf find-or-create failed — abort so the whole flow rolls back
          // instead of writing stock to a null location.
          throw new Error('Could not resolve the shelf location. Please re-pick or re-enter the shelf.');
        }
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
      });
    } catch (err) {
      // Writes rolled back — surface the reason and do NOT show success.
      Alert.alert(
        'Save failed',
        err instanceof Error ? err.message : 'Could not add stock. Please try again.',
      );
      return;
    }

    Alert.alert('Stock Added', `+${qty} ${effectiveUnit} added successfully.`, [
      { text: 'OK', onPress: () => router.back() },
    ]);
  }

  const showReadOnly = !isCreatingNew && autofillItem !== null;
  // Existing unit-tracked item (selected via picker or barcode autofill): its on-hand
  // is the count of available units — it must NEVER write stock_by_location.
  const existingUnitTracked = autofillItem?.unit_tracked === 1;
  // Unit-tracked path: hide Location/Quantity, no stock write.
  const isUnitTracked = existingUnitTracked;

  return (
    <>
      <Stack.Screen options={{ title: 'Add Stock to Location', headerShown: true }} />
      <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">

          {/* ── ITEM ─────────────────────────────────────────────────────── */}
          <FieldLabel>Item</FieldLabel>
          <SearchablePicker
            placeholder="Search existing items..."
            searchFn={itemSearch}
            value={selectedItem}
            onSelect={handleItemSelect}
            onCreate={handleItemCreate}
          />
          <AdvancedFields>
            <HidableField fieldId="inventory.barcode">
              <BarcodeInput
                value={barcode}
                onChange={setBarcode}
                placeholder="Scan or enter barcode (optional)"
                note={autofillItem ? `Auto-filled: ${autofillItem.name}` : undefined}
                noteTone="info"
              />
            </HidableField>
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

              {itemTypes.length > 0 && (
                <>
                  <FieldLabel style={{ marginTop: 12 }}>Item type</FieldLabel>
                  <View style={s.unitRow}>
                    {itemTypes.map(t => (
                      <FilterChip
                        key={t.id}
                        label={t.icon ? `${t.icon} ${t.label}` : t.label}
                        active={itemType === t.label}
                        onPress={() => selectItemType(t)}
                      />
                    ))}
                  </View>
                </>
              )}

              <FieldLabel style={{ marginTop: 12 }}>Unit</FieldLabel>
              {unitOptions.length > 0 ? (
                <View style={s.unitRow}>
                  {unitOptions.map(u => (
                    <FilterChip
                      key={u}
                      label={u}
                      active={unit === u}
                      onPress={() => setUnit(u)}
                    />
                  ))}
                </View>
              ) : (
                <AppInput
                  placeholder="Unit (e.g. each)"
                  value={unit}
                  onChangeText={setUnit}
                />
              )}

              <HidableField fieldId="inventory.pack_size">
                <FieldLabel style={{ marginTop: 12 }}>Pack size (optional)</FieldLabel>
                <AppInput
                  placeholder={`Units per pack — e.g. 4 = a 4-${unit || 'unit'} pack`}
                  value={packSize}
                  onChangeText={setPackSize}
                  keyboardType="decimal-pad"
                />
              </HidableField>

              <HidableField fieldId="inventory.home_location">
                <FieldLabel style={{ marginTop: 12 }}>Home location (where it belongs)</FieldLabel>
                <SearchablePicker
                  placeholder="Search shelves… (type a new one to add it)"
                  options={homeLocationOptions}
                  value={homeLocation}
                  onSelect={(opt) => setHomeLocation(prev => (prev?.id === opt.id ? null : opt))}
                  onCreate={(text) => setHomeLocation({ id: '__new__', label: text })}
                />
              </HidableField>

              <AdvancedFields>
                <HidableField fieldId="inventory.description">
                  <AppInput
                    style={s.multiline}
                    placeholder="Description (optional)"
                    value={description}
                    onChangeText={setDescription}
                    multiline
                    numberOfLines={3}
                  />
                </HidableField>
                <HidableField fieldId="inventory.supplier">
                  <SuggestInput
                    value={supplier}
                    onChange={setSupplier}
                    suggestions={supplierOptions}
                    placeholder="Supplier / Vendor (optional)"
                  />
                </HidableField>
                <HidableField fieldId="inventory.model">
                  <SuggestInput
                    label=""
                    value={model}
                    onChange={setModel}
                    suggestions={modelOptions}
                    placeholder="Color / Model (optional)"
                  />
                </HidableField>
                <View style={s.switchRow}>
                  <Text style={s.switchLabel}>Returnable? (expected back via Check In)</Text>
                  <Switch value={returnable} onValueChange={setReturnable} />
                </View>
                <HidableField fieldId="inventory.min_qty_alert">
                  <FieldLabel style={{ marginTop: 12 }}>Stock thresholds</FieldLabel>
                  <AppInput
                    placeholder="Low-stock alert (0 = off)"
                    value={minAlert}
                    onChangeText={setMinAlert}
                    keyboardType="decimal-pad"
                  />
                </HidableField>
                <HidableField fieldId="inventory.reorder_to">
                  <AppInput
                    placeholder="Reorder up to (optional)"
                    value={reorderTo}
                    onChangeText={setReorderTo}
                    keyboardType="decimal-pad"
                  />
                </HidableField>
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
              {locationHasShelves && (
                <>
                  <FieldLabel style={{ marginTop: 12 }}>Shelf</FieldLabel>
                  <SearchablePicker
                    placeholder="Type or pick a shelf (e.g. A1)…"
                    options={shelfOptions}
                    value={shelfValue}
                    onSelect={(opt) => setShelfValue(prev => (prev?.id === opt.id ? null : opt))}
                    onCreate={(text) => setShelfValue({ id: '__new__', label: text })}
                  />
                </>
              )}
            </>
          )}

          {/* ── QUANTITY ─────────────────────────────────────────────────── */}
          {!isUnitTracked && (
            <>
              <FieldLabel style={{ marginTop: 12 }}>Quantity to Add</FieldLabel>
              {!!effectivePackSize && effectivePackSize > 1 && (
                <View style={s.packModeRow}>
                  <FilterChip
                    label={`Packs of ${effectivePackSize}`}
                    active={packMode === 'packs'}
                    onPress={() => setPackMode('packs')}
                  />
                  <FilterChip
                    label={`Loose ${autofillItem?.unit ?? unit}`}
                    active={packMode === 'units'}
                    onPress={() => setPackMode('units')}
                  />
                </View>
              )}
              <AppInput
                placeholder={usePacks ? 'Number of packs' : 'Enter quantity'}
                value={quantity}
                onChangeText={setQuantity}
                keyboardType="decimal-pad"
              />
              {usePacks && !!parseFloat(quantity) && (
                <Text style={s.packHint}>
                  = {parseFloat(quantity) * (effectivePackSize as number)} {autofillItem?.unit ?? unit}
                </Text>
              )}
            </>
          )}

          {/* ── ACTIONS ──────────────────────────────────────────────────── */}
          {isUnitTracked && (
            <View style={s.noteBox}>
              <Text style={s.noteText}>
                This item tracks individual units. Open the item to add or manage its units.
              </Text>
            </View>
          )}
          {/* The existingUnitTracked branch only navigates (no write), so it
              stays enabled during maintenance — only the writing modes gate. */}
          <PrimaryButton
            label={existingUnitTracked ? 'Open item to add units' : 'Add Stock'}
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
  packModeRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  packHint: { fontSize: 13, color: colors.primary, fontWeight: '600', marginTop: 4 },
  readonlyCard: {
    backgroundColor: colors.primaryBg, borderRadius: 10, borderWidth: 1,
    borderColor: colors.border, paddingHorizontal: 14, paddingVertical: 10,
  },
  readonlyName: { fontSize: 14, fontWeight: '700', color: colors.textPrimary },
  readonlyMeta: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
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
});
