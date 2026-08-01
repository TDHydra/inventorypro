import { useState, useMemo, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { generateUUID } from '../../../src/utils/uuid';
import {
  upsertItem, getItemByBarcode, getDistinctValues, searchItems, getItemById,
  adjustStock, getStockQuantity,
} from '../../../src/db/queries/items';
import type { InventoryItem } from '../../../src/db/queries/items';
import { getAllLocations, getLocationPath, getShelfLocations, findOrCreateShelf, findOrCreateShelfByName } from '../../../src/db/queries/locations';
import { appendLog } from '../../../src/db/queries/log';
import { appendOutbox } from '../../../src/sync/outbox';
import { getItemTypes, parseItemTypeMeta } from '../../../src/db/queries/taxonomy';
import { PRODUCT_CLASS_IDS, getUnitsForClass } from '../../../src/constants/units';
import { BarcodeInput } from '../../../src/components/BarcodeInput';
import { SearchablePicker } from '../../../src/components/SearchablePicker';
import type { PickerOption } from '../../../src/components/SearchablePicker';
import { LocationShelfPicker } from '../../../src/components/pickers';
import { useSession } from '../../../src/hooks/useSession';
import { useTableVersion } from '../../../src/hooks/useDataVersion';
import { useCurrentPosition } from '../../../src/hooks/useCurrentPosition';
import { sortByProximity } from '../../../src/location/proximity';
import { LocationSuggestionBanner } from '../../../src/components/LocationSuggestionBanner';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { runInTransaction } from '../../../src/db/tx';
import { parseQuantity, parseOptionalCount, parsePackSize, MAX_QUANTITY } from '../../../src/lib/validation';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { FormScreen } from '../../../src/components/ui/FormScreen';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import { AdvancedFields } from '../../../src/components/ui/AdvancedFields';
import { HidableField } from '../../../src/components/ui/HidableField';
import { AutofillTextField } from '../../../src/components/ui/AutofillTextField';
import { SelectField } from '../../../src/components/ui/SelectField';
import { QuantityStepper } from '../../../src/components/ui/QuantityStepper';
import { TextField } from '../../../src/components/ui/TextField';

export default function AddStockScreen() {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();
  const { barcode: initialBarcode, locationId: initialLocationId } =
    useLocalSearchParams<{ barcode?: string; locationId?: string }>();
  const { coords, request } = useCurrentPosition();

  // Option lists re-read when a local write or sync pull touches their tables —
  // e.g. a location created via nested quick-add appears without remount.
  const version = useTableVersion(['taxonomy_types', 'locations', 'inventory_items']);

  // Admin-managed Item Type taxonomy (PPE, Filters, …). Each carries its units +
  // unit class in meta. Selecting a type drives the unit class, unit options, and
  // the item's catalog category (mirrors quick-add). Equipment is NOT here.
  const itemTypes = useMemo(() => getItemTypes(), [version]);
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
  // 0 = off (QuantityStepper has no blank state; matches the app's existing
  // "0 = off" convention for this field, shown on the pre-kit placeholder).
  const [minAlert, setMinAlert] = useState(0);
  const [reorderTo, setReorderTo] = useState('');
  // Optional "home" location for a newly-created item (where it belongs). Nullable.
  // Distinct from the add-stock target location below.
  const [homeLocation, setHomeLocation] = useState<PickerOption | null>(null);

  // ── Location + quantity state ─────────────────────────────────────────────
  const [selectedLocation, setSelectedLocation] = useState<PickerOption | null>(null);
  const [shelfValue, setShelfValue] = useState<PickerOption | null>(null); // shelf within the location
  // 0 = not yet entered (QuantityStepper has no blank state); parseQuantity still
  // rejects 0 at save ("must be greater than zero"), same as blank did before.
  const [quantity, setQuantity] = useState(0);
  // 0 = no pack tracking (QuantityStepper has no blank state; mirrors minAlert's
  // "0 = off" convention). 1 stays a validation error (a pack of 1 is just the unit).
  const [packSize, setPackSize] = useState(0); // new item: units per pack
  const [packMode, setPackMode] = useState<'packs' | 'units'>('packs');

  // ── Data ──────────────────────────────────────────────────────────────────
  // DB-backed product search (not a capped pre-load) so the full catalog is
  // reachable; kind='product' filtered IN-SQL.
  const itemSearch = useMemo(
    () => (q: string): PickerOption[] =>
      searchItems(q, 12, 0, undefined, 'product').map(i => ({ id: i.id, label: i.name, sublabel: i.barcode ?? i.kind })),
    [],
  );

  const allLocations = useMemo(() => getAllLocations(), [version]);
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
  }, [allLocations, locationById, version]);

  // Units available for the current selection: the selected item type's curated
  // list, falling back to the unit class's units (or piece) when none/empty.
  const selectedType = itemTypes.find(t => t.label === itemType) ?? null;
  const typeUnits = selectedType ? parseItemTypeMeta(selectedType.meta).units : [];
  const unitOptions = typeUnits.length > 0 ? typeUnits : getUnitsForClass(unitCat);
  // Unit picker options: the context-appropriate curated list first, plus any
  // unit ever typed anywhere in the catalog (deduped) so a legacy/custom unit
  // stays reachable.
  const unitDbOptions = useMemo(() => getDistinctValues('unit'), [version]);
  const mergedUnitOptions = useMemo(() => {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const u of unitOptions) if (!seen.has(u)) { seen.add(u); merged.push(u); }
    for (const u of unitDbOptions) if (!seen.has(u)) { seen.add(u); merged.push(u); }
    return merged;
  }, [unitOptions, unitDbOptions]);

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
  // route param (set when arriving from a location detail screen). Initial-value
  // seed — keyed on the param ONLY (locationById now changes identity on every
  // table-version bump; re-running here would clobber a user-changed selection).
  useEffect(() => {
    if (!initialLocationId) return;
    const loc = locationById.get(initialLocationId);
    if (loc) setSelectedLocation({ id: loc.id, label: loc.name });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot seed per param
  }, [initialLocationId]);

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

  // The selected location's "has shelves" flag routes stock to a shelf child in
  // handleSave (LocationShelfPicker gates the Shelf field on the same flag).
  const selectedLocFull = selectedLocation ? locationById.get(selectedLocation.id) : undefined;
  const locationHasShelves = selectedLocFull?.has_shelves === 1;

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
    setMinAlert(0); setReorderTo('');
    setHomeLocation(null);
    setSelectedLocation(null);
    setShelfValue(null);
    setQuantity(0);
    setPackSize(0);
    setPackMode('packs');
  }

  // Pack size in play for the current add: an existing item's stored pack_size,
  // or (when creating) the entered value. >1 means the Packs/Units toggle applies.
  const newItemPackSize = (() => {
    // 0 means "no pack tracking" (QuantityStepper's off state) — skip validation
    // so it doesn't surface the ≤1 error. Render-safe otherwise: parsePackSize
    // rejects negatives / ≤1 / non-integers. Invalid entries surface a precise
    // error in handleSave (no Alert here).
    if (packSize === 0) return null;
    const r = parsePackSize(String(packSize));
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
    // minAlert is already a valid clamped integer (QuantityStepper enforces
    // min 0) — no separate parse/Alert step needed, same effective range.
    const validatedMinAlert = minAlert;
    let validatedReorderTo: number | null = null;
    if (isCreatingNew) {
      // 0 means "no pack tracking" (QuantityStepper's off state, mirrors
      // minAlert) — skip validation so it doesn't surface the ≤1 error.
      if (packSize !== 0) {
        const packRes = parsePackSize(String(packSize));
        if (!packRes.ok) {
          Alert.alert('Invalid pack size', packRes.error);
          return;
        }
        validatedPackSize = packRes.value;
      }

      const reorderRes = parseOptionalCount(reorderTo, 'Reorder up to');
      if (!reorderRes.ok) {
        Alert.alert('Invalid reorder amount', reorderRes.error);
        return;
      }
      validatedReorderTo = reorderRes.value;
    }

    // Entered value is packs or base units depending on the toggle; stock is
    // always written in BASE units (entered × pack_size when adding packs).
    const qtyRes = parseQuantity(String(quantity));
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
          user_id: realUser?.id ?? null,
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
      <FormScreen contentContainerStyle={s.content}>

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
              <TextField
                label="Item name"
                required
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

              <View style={{ marginTop: 12 }}>
                {/* No curated/prior units at all (fresh install, unrecognized class) —
                    fall back to free text so the field is never a dead end. */}
                {mergedUnitOptions.length > 0 ? (
                  <SelectField
                    label="Unit"
                    value={unit}
                    options={mergedUnitOptions.map(u => ({ id: u, label: u }))}
                    onSelect={setUnit}
                  />
                ) : (
                  <TextField label="Unit" placeholder="e.g. each" value={unit} onChangeText={setUnit} />
                )}
              </View>

              <HidableField fieldId="inventory.pack_size">
                <View style={{ marginTop: 12 }}>
                  <QuantityStepper
                    label="Pack size (optional, 0 = no pack tracking)"
                    value={packSize}
                    onChange={setPackSize}
                    min={0}
                    max={MAX_QUANTITY}
                    unit={`${unit || 'unit'} per pack`}
                  />
                </View>
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
                  <TextField
                    label="Description (optional)"
                    value={description}
                    onChangeText={setDescription}
                    multiline
                    numberOfLines={3}
                  />
                </HidableField>
                <HidableField fieldId="inventory.supplier">
                  <AutofillTextField
                    label="Supplier / Vendor"
                    table="inventory_items"
                    column="supplier"
                    value={supplier}
                    onChangeText={setSupplier}
                    placeholder="Supplier / Vendor (optional)"
                  />
                </HidableField>
                <HidableField fieldId="inventory.model">
                  <AutofillTextField
                    label="Color / Model"
                    table="inventory_items"
                    column="model"
                    value={model}
                    onChangeText={setModel}
                    placeholder="Color / Model (optional)"
                  />
                </HidableField>
                <View style={s.switchRow}>
                  <Text style={s.switchLabel}>Returnable? (expected back via Check In)</Text>
                  <Switch value={returnable} onValueChange={setReturnable} />
                </View>
                <HidableField fieldId="inventory.min_qty_alert">
                  <View style={{ marginTop: 12 }}>
                    <QuantityStepper
                      label="Low-stock alert (0 = off)"
                      value={minAlert}
                      onChange={setMinAlert}
                      min={0}
                      max={MAX_QUANTITY}
                    />
                  </View>
                </HidableField>
                <HidableField fieldId="inventory.reorder_to">
                  <View style={{ marginTop: 12 }}>
                    {/* Stays a plain text field (not QuantityStepper): blank (no
                        target) and 0 (a real, if unusual, reorder-to-zero value)
                        are distinct here, unlike minAlert's "0 = off". */}
                    <TextField
                      label="Reorder up to (optional)"
                      placeholder="Reorder up to (optional)"
                      value={reorderTo}
                      onChangeText={setReorderTo}
                      keyboardType="decimal-pad"
                    />
                  </View>
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
              <LocationShelfPicker
                proximitySort
                locationValue={selectedLocation}
                shelfValue={shelfValue}
                onChangeLocation={setSelectedLocation}
                onChangeShelf={setShelfValue}
              />
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
              <QuantityStepper
                value={quantity}
                onChange={setQuantity}
                min={0}
                max={MAX_QUANTITY}
                allowDecimal
                unit={usePacks ? 'packs' : (autofillItem?.unit ?? unit)}
              />
              {usePacks && quantity > 0 && (
                <Text style={s.packHint}>
                  = {quantity * (effectivePackSize as number)} {autofillItem?.unit ?? unit}
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

      </FormScreen>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  content: { padding: 16, gap: 10, paddingBottom: 48 },
  packModeRow: { flexDirection: 'row', gap: 8, marginBottom: 8 },
  packHint: { fontSize: 13, color: t.colors.primary, fontWeight: '600', marginTop: 4 },
  readonlyCard: {
    backgroundColor: t.colors.primaryBg, borderRadius: 10, borderWidth: 1,
    borderColor: t.colors.border, paddingHorizontal: 14, paddingVertical: 10,
  },
  readonlyName: { fontSize: 14, fontWeight: '700', color: t.colors.textPrimary },
  readonlyMeta: { fontSize: 12, color: t.colors.textSecondary, marginTop: 2 },
  unitRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  secondaryRow: { flexDirection: 'row', justifyContent: 'center', gap: 28, marginTop: 12 },
  linkBtn: { paddingVertical: 8, paddingHorizontal: 16 },
  linkText: { color: t.colors.primary, fontSize: 15, fontWeight: '600' },
  cancelText: { color: t.colors.textMuted },
  noteBox: {
    backgroundColor: t.colors.primaryBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: t.colors.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 4,
  },
  noteText: {
    fontSize: 13,
    color: t.colors.primaryText,
    lineHeight: 18,
  },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: t.colors.surface, borderRadius: 10, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  switchLabel: { fontSize: 14, color: t.colors.textPrimary, flex: 1, marginRight: 12 },
});
