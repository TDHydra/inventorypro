import { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { generateUUID } from '../../utils/uuid';
import { upsertItem, getItemBySku, getDistinctValues, searchItems, adjustStock, getStockQuantity } from '../../db/queries/items';
import type { InventoryItem } from '../../db/queries/items';
import { resolveLocationShelf, resolveLocationShelfSelection } from '../../db/queries/locations';
import { getUnitInventoryLock } from '../../db/queries/access';
import { getMainStorageLocationId } from '../../db/mainStorage';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { useTableVersion } from '../../hooks/useDataVersion';
import { getItemTypes, parseItemTypeMeta, getItemTypeColorMap } from '../../db/queries/taxonomy';
import { resolveTypeColor } from '../../constants/typeColors';
import { PRODUCT_CLASS_IDS, getUnitsForClass } from '../../constants/units';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { runInTransaction } from '../../db/tx';
import { parsePackSize, parseQuantity, validateBarcode, validateName, validateText, MAX_QUANTITY } from '../../lib/validation';
import { MediaGallery } from '../MediaGallery';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { AppInput } from '../ui/AppInput';
import { FieldLabel } from '../ui/FieldLabel';
import { FilterChip } from '../ui/FilterChip';
import { FormScreen } from '../ui/FormScreen';
import { SelectField } from '../ui/SelectField';
import { QuickAddFooter } from './QuickAddFooter';
import { QuantityStepper } from '../ui/QuantityStepper';
import type { PickerOption } from '../SearchablePicker';
import { LocationShelfPicker } from '../pickers';
import { BarcodeInput } from '../BarcodeInput';
import { track } from '../../telemetry';
import type { QuickAddSaveMeta } from './justAdded';
import { canOfferStartingStock } from './stockGates';

// Pieces class id (migration 012) — the default unit class when no item type is
// selected (most products are counted in pieces).
const CLASS_PIECE_ID = PRODUCT_CLASS_IDS.piece;

interface Props {
  onSaved: (label: string, createdId?: string, meta?: QuickAddSaveMeta) => void;
}

// Audit a validation rejection — field path + rule name ONLY, never the value.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'quick_add', props: { field, rule } });
}

export default function ItemQuickAdd({ onSaved }: Props) {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const router = useRouter();
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();
  // Starting stock emits a stock_by_location INSERT that references the new
  // item. The server requires `add_inventory` for the parent inventory_items
  // INSERT and `checkin_inventory` for the stock INSERT itself — without the
  // former the parent is Forbidden-dropped and the stock INSERT FK-orphans
  // (retry-looping forever); without the latter the stock INSERT itself is
  // silently dropped. Only offer/emit starting stock when both gates will pass.
  const canAddItems = usePermission('add_inventory');
  const canCheckinStock = usePermission('checkin_inventory');
  const canStartStock = canOfferStartingStock({ canAddItems, canCheckinStock });
  const nameRef = useRef<TextInput>(null);
  // Prefilled barcode (e.g. arriving from the Scan Hub's "add as new item" flow).
  const params = useLocalSearchParams<{ barcode?: string }>();

  // Re-read the option lists when a sync pull touches the tables they come from.
  const optionsVersion = useTableVersion(['taxonomy_types', 'inventory_items']);

  // Admin-managed Item Type taxonomy (PPE, Filters, …). Each carries its units +
  // unit class in meta. Equipment is NOT here (own tab); items are kind='product'.
  const itemTypes = useMemo(() => getItemTypes(), [optionsVersion]);
  // Item Types are a managed taxonomy → an admin can override the auto color.
  const itemTypeColorMap = useMemo(() => getItemTypeColorMap(), [optionsVersion]);

  // Generate the item id up front so the photo thumbnail can upload to this
  // entity before the row is committed (mirrors the full Add screen). Reset on
  // clear so the next item gets a fresh id (and a fresh, empty thumbnail).
  const [itemId, setItemId] = useState(() => generateUUID());

  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState(params.barcode ?? ''); // seeded from a scan
  const [sku, setSku] = useState(''); // item # / part #
  const [description, setDescription] = useState('');
  const [currentStock, setCurrentStock] = useState(''); // optional starting qty (→ home location)
  // 0 = no pack tracking (QuantityStepper has no blank state; mirrors the full
  // Add screen's "0 = off" convention for this field).
  const [packSize, setPackSize] = useState(0); // units per pack (optional)
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
  // Unit picker options: the context-appropriate curated list first, plus any
  // unit ever typed anywhere in the catalog (deduped) so a legacy/custom unit
  // stays reachable (mirrors the full Add screen).
  const unitDbOptions = useMemo(() => getDistinctValues('unit'), [optionsVersion]);
  const mergedUnitOptions = useMemo(() => {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const u of unitOptions) if (!seen.has(u)) { seen.add(u); merged.push(u); }
    for (const u of unitDbOptions) if (!seen.has(u)) { seen.add(u); merged.push(u); }
    return merged;
  }, [unitOptions, unitDbOptions]);

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
    setPackSize(0);
    setItemType('');
    setUnitCat(CLASS_PIECE_ID);
    setUnit(getUnitsForClass(CLASS_PIECE_ID)[0] ?? 'each');
    const def = storageDefault();
    setSelectedLocation(def.location);
    setShelfValue(def.shelf);
    setNameError('');
  }

  function handleSave() {
    track('action', 'quickadd_save_item', { screen: 'quick_add' });
    // Bounded, control-char-free name (same 'Name is required.' copy as before
    // for the blank case) — this form is the only pre-server gate when offline.
    const nameResult = validateName(name);
    if (!nameResult.ok) {
      trackReject('item.name', nameResult.rule);
      setNameError(nameResult.error);
      return;
    }
    const trimmedName = nameResult.value;
    setNameError('');

    // Optional free-text fields: bounded + control-char-rejecting, checked
    // BEFORE any local write. Blank stays fine (→ null below, as before).
    const skuResult = validateText(sku, { label: 'Item # / Part #', max: 100 });
    if (!skuResult.ok) { trackReject('item.sku', skuResult.rule); Alert.alert('Check item #', skuResult.error); return; }
    const descResult = validateText(description, { label: 'Description' });
    if (!descResult.ok) { trackReject('item.description', descResult.rule); Alert.alert('Check description', descResult.error); return; }
    const unitResult = validateText(unit, { label: 'Unit', max: 40 });
    if (!unitResult.ok) { trackReject('item.unit', unitResult.rule); Alert.alert('Check unit', unitResult.error); return; }
    let barcodeValue: string | null = null;
    if (barcode.trim()) {
      const bc = validateBarcode(barcode);
      if (!bc.ok) { trackReject('item.barcode', bc.rule); Alert.alert('Check barcode', bc.error); return; }
      barcodeValue = bc.value;
    }

    // Optional starting quantity. Blank → no stock written. If provided, it must
    // be a valid positive number (parseQuantity guards NaN / ≤0 / overflow).
    // Permission-gated (canStartStock): the field is hidden without the perms,
    // but never emit the stock INSERT from stale state either — a stock row
    // whose parent item push is rejected would FK-orphan server-side.
    let stockQty = 0;
    if (currentStock.trim() && canStartStock) {
      const q = parseQuantity(currentStock, 'Current stock');
      if (!q.ok) { trackReject('item.current_stock', q.rule); Alert.alert('Check current stock', q.error); return; }
      stockQty = q.value;
    }

    // 0 means "no pack tracking" (QuantityStepper's off state) — skip validation
    // so it doesn't surface the ≤1 error. Mirrors the full Add screen.
    if (packSize !== 0) {
      const packRes = parsePackSize(String(packSize));
      if (!packRes.ok) {
        trackReject('item.pack_size', packRes.rule);
        Alert.alert('Invalid pack size', packRes.error);
        return;
      }
    }

    const now = new Date().toISOString();
    const id = itemId;

    // Resolve the home location. Two-stage: if the chosen location has shelves and
    // a shelf is picked/typed, home is that shelf (created when new); otherwise the
    // location itself. A failed shelf-create must NOT silently drop the location.
    const homeResult = resolveLocationShelfSelection(selectedLocation, shelfValue);
    if (!homeResult.ok) {
      Alert.alert(
        'Couldn’t add that shelf',
        `We couldn’t create the shelf “${homeResult.shelfLabel}”. Pick an existing shelf or try again.`,
      );
      return;
    }
    const homeLocationId = homeResult.id;

    // #162: a starting-stock write into another team's vehicle/locker is locked
    // without the cross-team perm (defensive — the picker hides units today,
    // but the server rejects the stock INSERT regardless).
    if (stockQty > 0 && homeLocationId) {
      const teamLock = getUnitInventoryLock(user, homeLocationId);
      if (teamLock.locked) {
        trackReject('item.home_location', 'foreign_team_unit');
        Alert.alert('Team inventory', teamLock.reason ?? 'This unit’s inventory belongs to another team.');
        return;
      }
    }

    // Current stock must attach to a location — use the home location. Require
    // one rather than silently dropping the entered quantity.
    if (stockQty > 0 && !homeLocationId) {
      trackReject('item.home_location', 'required');
      Alert.alert(
        'Set a home location',
        'To record current stock, pick or add a home location below so we know where it lives.',
      );
      return;
    }

    const item: InventoryItem = {
      id,
      name: trimmedName,
      barcode: barcodeValue,
      description: descResult.value || null,
      sku: skuResult.value || null,
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
      // 0 = no pack tracking (QuantityStepper's off state) → null, mirroring
      // the full Add screen's save handling.
      pack_size: packSize > 0 ? packSize : null,
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
          user_id: realUser?.id ?? null,
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
            user_id: realUser?.id ?? null,
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
    onSaved(trimmedName, id, { kind: 'item' });
    clearForm();
    setTimeout(() => nameRef.current?.focus(), 100);
  }

  return (
    // Owns its FormScreen (shell passes wrapForm={false}) so the Save/Done bar
    // sits in the sticky footer slot and floats above the keyboard (#118).
    <FormScreen
      contentContainerStyle={s.content}
      footer={<QuickAddFooter onSave={handleSave} disabled={locked} locked={locked} />}
    >
      <View style={s.topRow}>
        {/* Compact 64×64 photo thumbnail — keyed by itemId so it resets per item. */}
        <MediaGallery key={itemId} entityType="item" entityId={itemId} canUpload variant="thumb" />
        <TextInput
          ref={nameRef}
          style={[s.input, s.nameInput, !!nameError && s.inputError]}
          placeholder="Item name *"
          placeholderTextColor={t.colors.textMuted}
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

      {/* Plain input (no autofill): suggesting existing SKUs directly above the
          duplicate-SKU warning would invite duplicates. */}
      <FieldLabel>Item # / Part #</FieldLabel>
      <AppInput
        placeholder="Recommended"
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

      {canStartStock && (
        <>
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
        </>
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

      {mergedUnitOptions.length > 0 ? (
        <SelectField
          label="Unit"
          value={unit}
          options={mergedUnitOptions.map(u => ({ id: u, label: u }))}
          onSelect={setUnit}
          recentKey="unit"
        />
      ) : (
        <>
          <FieldLabel>Unit</FieldLabel>
          <AppInput
            placeholder="Unit (e.g. each)"
            value={unit}
            onChangeText={setUnit}
          />
        </>
      )}

      <QuantityStepper
        label="Pack size (optional, 0 = no pack tracking)"
        value={packSize}
        onChange={setPackSize}
        min={0}
        max={MAX_QUANTITY}
        unit={`${unit || 'unit'} per pack`}
      />

      <FieldLabel>Home location (where it belongs)</FieldLabel>
      <LocationShelfPicker
        locationValue={selectedLocation}
        shelfValue={shelfValue}
        onChangeLocation={setSelectedLocation}
        onChangeShelf={setShelfValue}
      />

    </FormScreen>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // Mirrors the shell's default FormScreen content padding + this form's row gap.
  content: { padding: t.spacing.lg, paddingBottom: 48, gap: 10 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  nameInput: { flex: 1 },
  input: {
    backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base, height: 44, fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary,
  },
  inputError: { borderColor: t.colors.danger },
  errorText: { fontSize: t.typography.fontSizes.caption, color: t.colors.danger, marginTop: -4 },
  skuHint: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginTop: -4, marginBottom: 2 },
  skuDup: { fontSize: t.typography.fontSizes.caption, color: t.colors.accent, fontWeight: '600', marginTop: -4, marginBottom: 2 },
  nameMatches: { backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border, marginTop: -2, overflow: 'hidden' },
  nameMatchesHint: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted, fontWeight: '700', textTransform: 'uppercase', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 },
  nameMatchRow: { paddingHorizontal: 12, paddingVertical: 9, borderTopWidth: 1, borderTopColor: t.colors.borderDetail, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  nameMatchLabel: { fontSize: t.typography.fontSizes.body2, color: t.colors.textPrimary, flex: 1 },
  nameMatchSub: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  // Item-type chip + its colored type dot, grouped so they read as one unit.
  chipWithDot: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  typeDot: { width: 9, height: 9, borderRadius: 5 },
});
