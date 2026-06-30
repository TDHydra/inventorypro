import { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { generateUUID } from '../../utils/uuid';
import { upsertItem, getItemBySku, searchItems, adjustStock, getStockQuantity } from '../../db/queries/items';
import type { InventoryItem } from '../../db/queries/items';
import { getAllLocations, getShelvesForParent, findOrCreateShelf, resolveLocationShelf } from '../../db/queries/locations';
import { getMainStorageLocationId } from '../../db/mainStorage';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { getItemTypes, parseItemTypeMeta, getItemTypeColorMap } from '../../db/queries/taxonomy';
import { resolveTypeColor } from '../../constants/typeColors';
import { PRODUCT_CLASS_IDS, getUnitsForClass } from '../../constants/units';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { runInTransaction } from '../../db/tx';
import { parsePackSize, parseQuantity } from '../../lib/validation';
import { MediaGallery } from '../MediaGallery';
import { colors, spacing, radii, fontSizes } from '../../theme';
import { PrimaryButton } from '../ui/PrimaryButton';
import { AppInput } from '../ui/AppInput';
import { FieldLabel } from '../ui/FieldLabel';
import { FilterChip } from '../ui/FilterChip';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';
import { BarcodeInput } from '../BarcodeInput';

// Pieces class id (migration 012) — the default unit class when no item type is
// selected (most products are counted in pieces).
const CLASS_PIECE_ID = PRODUCT_CLASS_IDS.piece;

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

export default function ItemQuickAdd({ onSaved }: Props) {
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const nameRef = useRef<TextInput>(null);
  // Prefilled barcode (e.g. arriving from the Scan Hub's "add as new item" flow).
  const params = useLocalSearchParams<{ barcode?: string }>();

  // Admin-managed Item Type taxonomy (PPE, Filters, …). Each carries its units +
  // unit class in meta. Equipment is NOT here (own tab); items are kind='product'.
  const itemTypes = useMemo(() => getItemTypes(), []);
  // Item Types are a managed taxonomy → an admin can override the auto color.
  const itemTypeColorMap = useMemo(() => getItemTypeColorMap(), []);

  // Generate the item id up front so the photo thumbnail can upload to this
  // entity before the row is committed (mirrors the full Add screen). Reset on
  // clear so the next item gets a fresh id (and a fresh, empty thumbnail).
  const [itemId, setItemId] = useState(() => generateUUID());

  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState(params.barcode ?? ''); // seeded from a scan
  const [sku, setSku] = useState(''); // item # / part #
  const [description, setDescription] = useState('');
  const [currentStock, setCurrentStock] = useState(''); // optional starting qty (→ home location)
  const [packSize, setPackSize] = useState(''); // units per pack (optional)
  const [itemType, setItemType] = useState<string>(''); // selected item_category label → category
  // unit_category stores a product_class id (drives formatQuantity decimals).
  const [unitCat, setUnitCat] = useState<string>(CLASS_PIECE_ID);
  const [unit, setUnit] = useState<string>(getUnitsForClass(CLASS_PIECE_ID)[0] ?? 'each');
  // Optional "home" location. Two-stage: pick a location, and if it has shelves,
  // pick (or add) a shelf. Defaults to the admin-set "main storage area" (which may
  // itself be a shelf, resolved to its location + shelf) — the user can change it.
  function storageDefault() {
    return resolveLocationShelf(getMainStorageLocationId());
  }
  const [selectedLocation, setSelectedLocation] = useState<PickerOption | null>(() => storageDefault().location);
  const [shelfValue, setShelfValue] = useState<PickerOption | null>(() => storageDefault().shelf);
  const [nameError, setNameError] = useState('');

  // Location typeahead over ALL locations (parent shown as sublabel). Selecting a
  // location whose has_shelves flag is set reveals a second ranked shelf picker.
  const allLocations = useMemo(() => getAllLocations(), []);
  const locationById = useMemo(() => new Map(allLocations.map(l => [l.id, l])), [allLocations]);
  const locationOptions = useMemo<PickerOption[]>(
    () => allLocations.map(l => {
      const parentName = l.parent_id ? locationById.get(l.parent_id)?.name : undefined;
      return { id: l.id, label: l.name, sublabel: parentName };
    }),
    [allLocations, locationById],
  );

  // The selected location's has_shelves flag drives the Shelf field.
  const selectedLocFull = selectedLocation ? locationById.get(selectedLocation.id) : undefined;
  const locationHasShelves = selectedLocFull?.has_shelves === 1;
  const shelfOptions = useMemo<PickerOption[]>(
    () => (locationHasShelves && selectedLocation)
      ? getShelvesForParent(selectedLocation.id).map(s => ({ id: s.id, label: s.name }))
      : [],
    [locationHasShelves, selectedLocation],
  );

  // Selecting a location resets the shelf (shelf is per-location); tap again to clear.
  function handleLocationSelect(opt: PickerOption) {
    setShelfValue(null);
    setSelectedLocation(prev => (prev?.id === opt.id ? null : opt));
  }

  // Duplicate detection: does the typed item # already exist in the catalog?
  const skuMatch = useMemo(() => getItemBySku(sku), [sku]);

  // Dynamic product-name search: as you type a name, surface existing catalog
  // items so you can spot a duplicate (or jump to it) instead of re-creating it.
  const nameMatches = useMemo(() => {
    const q = name.trim();
    if (q.length < 2) return [];
    return searchItems(q, 5, 0, undefined, 'product').filter(i => i.name.toLowerCase() !== q.toLowerCase());
  }, [name]);

  // Tapping the "already in system" warning offers to cancel adding the duplicate
  // (or jump to the existing item to add stock to it instead).
  function onDuplicateTap() {
    if (!skuMatch) return;
    Alert.alert(
      'Item # already in system',
      `"${skuMatch.name}" already uses item # ${skuMatch.sku}. Add stock to it instead of creating a duplicate?`,
      [
        { text: 'Keep adding new', style: 'cancel' },
        { text: 'Open existing item', onPress: () => router.push({ pathname: '/(app)/(inventory)/[id]', params: { id: skuMatch.id } }) },
        { text: 'Cancel', style: 'destructive', onPress: () => router.back() },
      ],
    );
  }

  // Units available for the current selection: the selected item type's curated
  // list, falling back to the unit class's units (or piece) when none/empty.
  const selectedType = itemTypes.find(t => t.label === itemType) ?? null;
  const typeUnits = selectedType ? parseItemTypeMeta(selectedType.meta).units : [];
  const unitOptions = typeUnits.length > 0 ? typeUnits : getUnitsForClass(unitCat);

  // Pick/clear an item type — selecting one auto-sets the units + unit class to
  // whatever that type allows (the whole point of this screen).
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

  function clearForm() {
    setName('');
    setBarcode('');
    setSku('');
    setDescription('');
    setCurrentStock('');
    setItemId(generateUUID()); // fresh id → the photo thumbnail resets for the next item
    setPackSize('');
    setItemType('');
    setUnitCat(CLASS_PIECE_ID);
    setUnit(getUnitsForClass(CLASS_PIECE_ID)[0] ?? 'each');
    const def = storageDefault();
    setSelectedLocation(def.location);
    setShelfValue(def.shelf);
    setNameError('');
  }

  function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Name is required.');
      return;
    }
    setNameError('');

    // Validate the optional pack size up front (rejects negatives / fractions /
    // a pack of 1). Empty → null (no pack). Stop before any writes on bad input.
    const packResult = parsePackSize(packSize);
    if (!packResult.ok) {
      Alert.alert('Check pack size', packResult.error);
      return;
    }

    // Optional starting quantity. Blank → no stock written. If provided, it must
    // be a valid positive number (parseQuantity guards NaN / ≤0 / overflow).
    let stockQty = 0;
    if (currentStock.trim()) {
      const q = parseQuantity(currentStock, 'Current stock');
      if (!q.ok) { Alert.alert('Check current stock', q.error); return; }
      stockQty = q.value;
    }

    const now = new Date().toISOString();
    const id = itemId;

    // Resolve the home location. Two-stage: if the chosen location has shelves and
    // a shelf is picked/typed, home is that shelf (created when new); otherwise the
    // location itself. A failed shelf-create must NOT silently drop the location.
    let homeLocationId: string | null = null;
    if (selectedLocation) {
      if (locationHasShelves && shelfValue?.label) {
        if (shelfValue.id === '__new__') {
          let resolved: string | null = null;
          try {
            resolved = findOrCreateShelf(selectedLocation.id, shelfValue.label);
          } catch {
            resolved = null;
          }
          if (!resolved) {
            Alert.alert(
              'Couldn’t add that shelf',
              `We couldn’t create the shelf “${shelfValue.label}”. Pick an existing shelf or try again.`,
            );
            return;
          }
          homeLocationId = resolved;
        } else {
          homeLocationId = shelfValue.id;
        }
      } else {
        homeLocationId = selectedLocation.id;
      }
    }

    // Current stock must attach to a location — use the home location. Require
    // one rather than silently dropping the entered quantity.
    if (stockQty > 0 && !homeLocationId) {
      Alert.alert(
        'Set a home location',
        'To record current stock, pick or add a home location below so we know where it lives.',
      );
      return;
    }

    const item: InventoryItem = {
      id,
      name: trimmedName,
      barcode: barcode.trim() || null,
      description: description.trim() || null,
      sku: sku.trim() || null,
      supplier: null,
      model: null,
      kind: 'product',
      category: itemType || null,
      returnable: 0,
      unit_tracked: 0,
      tag_prefix: null,
      unit_category: unitCat,
      unit,
      min_qty_alert: 0,
      reorder_to: null,
      active: 1,
      updated_at: now,
      synced_at: null,
      home_location_id: homeLocationId,
      pack_size: packResult.value,
    };

    // Atomic write: upsert + outbox + log all-or-nothing so a mid-flow failure
    // can't leave an orphaned item or a lost outbox/log entry.
    try {
      runInTransaction(() => {
        upsertItem(item);
        // synced_at is a local-only column — strip it from the outbox payload.
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

        // Optional starting stock → home location (same all-or-nothing transaction).
        if (stockQty > 0 && homeLocationId) {
          adjustStock(id, homeLocationId, stockQty);
          const newQty = getStockQuantity(id, homeLocationId);
          appendOutbox('INSERT', 'stock_by_location', {
            item_id: id, location_id: homeLocationId, quantity: newQty, updated_at: now,
          });
          appendLog({
            action: 'add_stock',
            entity_type: 'item',
            entity_id: id,
            user_id: user?.id ?? null,
            team_id: null,
            from_location_id: null,
            to_location_id: homeLocationId,
            quantity: stockQty,
            unit,
            job_id: null,
            note: null,
            metadata: null,
            device_id: null,
          });
        }
      });
    } catch {
      Alert.alert(
        'Couldn’t save item',
        'Something went wrong saving this item, so nothing was changed. Please try again.',
      );
      return;
    }

    // Writes succeeded — only now clear the form and signal success.
    onSaved(trimmedName, id);
    clearForm();
    setTimeout(() => nameRef.current?.focus(), 100);
  }

  return (
    <View style={s.container}>
      <View style={s.topRow}>
        {/* Compact 64×64 photo thumbnail — keyed by itemId so it resets per item. */}
        <MediaGallery key={itemId} entityType="item" entityId={itemId} canUpload variant="thumb" />
        <TextInput
          ref={nameRef}
          style={[s.input, s.nameInput, !!nameError && s.inputError]}
          placeholder="Item name *"
          placeholderTextColor={colors.textMuted}
          value={name}
          onChangeText={t => { setName(t); if (nameError) setNameError(''); }}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={handleSave}
        />
      </View>
      {!!nameError && <Text style={s.errorText}>{nameError}</Text>}

      {nameMatches.length > 0 && (
        <View style={s.nameMatches}>
          <Text style={s.nameMatchesHint}>Already in catalog?</Text>
          {nameMatches.map(m => (
            <TouchableOpacity
              key={m.id}
              style={s.nameMatchRow}
              onPress={() => router.push({ pathname: '/(app)/(inventory)/[id]', params: { id: m.id } })}
            >
              <Text style={s.nameMatchLabel} numberOfLines={1}>{m.name}</Text>
              {!!m.sku && <Text style={s.nameMatchSub}>#{m.sku}</Text>}
            </TouchableOpacity>
          ))}
        </View>
      )}

      <AppInput
        placeholder="Item # / Part # (recommended)"
        value={sku}
        onChangeText={setSku}
        autoCapitalize="characters"
      />
      {sku.trim() && skuMatch ? (
        <TouchableOpacity onPress={onDuplicateTap} activeOpacity={0.7}>
          <Text style={s.skuDup}>⚠️ Item # already in system: {skuMatch.name} — tap if this is a duplicate</Text>
        </TouchableOpacity>
      ) : !sku.trim() ? (
        <Text style={s.skuHint}>💡 Most items have a part # — adding it makes them quicker to find.</Text>
      ) : null}

      <AppInput
        placeholder="Description (optional)"
        value={description}
        onChangeText={setDescription}
        multiline
      />

      <FieldLabel>Current stock (optional)</FieldLabel>
      <AppInput
        placeholder={`Starting quantity — e.g. 12 ${unit || 'each'}`}
        value={currentStock}
        onChangeText={setCurrentStock}
        keyboardType="decimal-pad"
      />
      {!!currentStock.trim() && (
        <Text style={s.skuHint}>📍 Added to the home location set below.</Text>
      )}

      <FieldLabel>Barcode (optional)</FieldLabel>
      <BarcodeInput
        value={barcode}
        onChange={setBarcode}
        placeholder="Scan or enter a barcode"
      />

      {itemTypes.length > 0 && (
        <>
          <FieldLabel>Item type</FieldLabel>
          <View style={s.chipRow}>
            {itemTypes.map(t => (
              <View key={t.id} style={s.chipWithDot}>
                <View style={[s.typeDot, { backgroundColor: resolveTypeColor(t.label, itemTypeColorMap[t.label]) }]} />
                <FilterChip
                  label={t.icon ? `${t.icon} ${t.label}` : t.label}
                  active={itemType === t.label}
                  onPress={() => selectItemType(t)}
                />
              </View>
            ))}
          </View>
        </>
      )}

      <FieldLabel>Unit</FieldLabel>
      {unitOptions.length > 0 ? (
        <View style={s.chipRow}>
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

      <FieldLabel>Pack size (optional)</FieldLabel>
      <AppInput
        placeholder={`Units per pack — e.g. 4 = a 4-${unit || 'unit'} pack`}
        value={packSize}
        onChangeText={setPackSize}
        keyboardType="decimal-pad"
      />

      <FieldLabel>Home location (where it belongs)</FieldLabel>
      <SearchablePicker
        placeholder="Search locations…"
        options={locationOptions}
        value={selectedLocation}
        onSelect={handleLocationSelect}
      />
      {locationHasShelves && (
        <>
          <FieldLabel>Shelf</FieldLabel>
          <SearchablePicker
            placeholder="Type or pick a shelf (e.g. A1)…"
            options={shelfOptions}
            value={shelfValue}
            onSelect={(opt) => setShelfValue(prev => (prev?.id === opt.id ? null : opt))}
            onCreate={(text) => setShelfValue({ id: '__new__', label: text })}
          />
        </>
      )}

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
  topRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  nameInput: { flex: 1 },
  input: {
    backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.base, height: 44, fontSize: fontSizes.body, color: colors.textPrimary,
  },
  inputError: { borderColor: colors.danger },
  errorText: { fontSize: fontSizes.caption, color: colors.danger, marginTop: -4 },
  skuHint: { fontSize: fontSizes.caption, color: colors.textMuted, marginTop: -4, marginBottom: 2 },
  skuDup: { fontSize: fontSizes.caption, color: colors.accent, fontWeight: '600', marginTop: -4, marginBottom: 2 },
  nameMatches: { backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, marginTop: -2, overflow: 'hidden' },
  nameMatchesHint: { fontSize: fontSizes.xs, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 },
  nameMatchRow: { paddingHorizontal: 12, paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.borderDetail, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  nameMatchLabel: { fontSize: fontSizes.body2, color: colors.textPrimary, flex: 1 },
  nameMatchSub: { fontSize: fontSizes.caption, color: colors.textMuted },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  // Item-type chip + its colored type dot, grouped so they read as one unit.
  chipWithDot: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  typeDot: { width: 9, height: 9, borderRadius: 5 },
  doneBtn: { alignItems: 'center', paddingVertical: spacing.md },
  doneBtnText: { color: colors.textSecondary, fontSize: fontSizes.md, fontWeight: '600' },
});
