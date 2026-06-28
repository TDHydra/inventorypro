import { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { generateUUID } from '../../utils/uuid';
import { upsertItem, getItemBySku } from '../../db/queries/items';
import type { InventoryItem } from '../../db/queries/items';
import { getAllLocations, getLocationPath, getShelfLocations } from '../../db/queries/locations';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { getItemTypes, parseItemTypeMeta } from '../../db/queries/taxonomy';
import { PRODUCT_CLASS_IDS, getUnitsForClass } from '../../constants/units';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { colors, spacing, radii, fontSizes } from '../../theme';
import { PrimaryButton } from '../ui/PrimaryButton';
import { AppInput } from '../ui/AppInput';
import { FieldLabel } from '../ui/FieldLabel';
import { FilterChip } from '../ui/FilterChip';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';

// Pieces class id (migration 012) — the default unit class when no item type is
// selected (most products are counted in pieces).
const CLASS_PIECE_ID = PRODUCT_CLASS_IDS.piece;

interface Props {
  onSaved: (label: string) => void;
}

export default function ItemQuickAdd({ onSaved }: Props) {
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const nameRef = useRef<TextInput>(null);

  // Admin-managed Item Type taxonomy (PPE, Filters, …). Each carries its units +
  // unit class in meta. Equipment is NOT here (own tab); items are kind='product'.
  const itemTypes = useMemo(() => getItemTypes(), []);

  const [name, setName] = useState('');
  const [sku, setSku] = useState(''); // item # / part #
  const [packSize, setPackSize] = useState(''); // units per pack (optional)
  const [itemType, setItemType] = useState<string>(''); // selected item_category label → category
  // unit_category stores a product_class id (drives formatQuantity decimals).
  const [unitCat, setUnitCat] = useState<string>(CLASS_PIECE_ID);
  const [unit, setUnit] = useState<string>(getUnitsForClass(CLASS_PIECE_ID)[0] ?? 'each');
  // Optional "home" location (where the item belongs, e.g. a shelf). Nullable.
  const [homeLocation, setHomeLocation] = useState<PickerOption | null>(null);
  const [nameError, setNameError] = useState('');

  // Home-location typeahead over Shelf-type locations (named WH-A1, SHOP-B3, …).
  // Falls back to the full breadcrumb list when no shelves exist yet so the field
  // stays usable.
  const homeLocationOptions = useMemo<PickerOption[]>(() => {
    const shelves = getShelfLocations();
    return shelves.length
      ? shelves.map(s => ({ id: s.id, label: s.name }))
      : getAllLocations().map(l => ({ id: l.id, label: getLocationPath(l.id) }));
  }, []);

  // Duplicate detection: does the typed item # already exist in the catalog?
  const skuMatch = useMemo(() => getItemBySku(sku), [sku]);

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
    setSku('');
    setPackSize('');
    setItemType('');
    setUnitCat(CLASS_PIECE_ID);
    setUnit(getUnitsForClass(CLASS_PIECE_ID)[0] ?? 'each');
    setHomeLocation(null);
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

    const item: InventoryItem = {
      id,
      name: trimmedName,
      barcode: null,
      description: null,
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
      home_location_id: homeLocation?.id ?? null,
      pack_size: (() => { const n = parseInt(packSize, 10); return Number.isFinite(n) && n > 1 ? n : null; })(),
    };

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
        placeholderTextColor={colors.textMuted}
        value={name}
        onChangeText={t => { setName(t); if (nameError) setNameError(''); }}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={handleSave}
      />
      {!!nameError && <Text style={s.errorText}>{nameError}</Text>}

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

      {itemTypes.length > 0 && (
        <>
          <FieldLabel>Item type</FieldLabel>
          <View style={s.chipRow}>
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
        placeholder="Search shelves…"
        options={homeLocationOptions}
        value={homeLocation}
        onSelect={(opt) => setHomeLocation(prev => (prev?.id === opt.id ? null : opt))}
      />

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
  input: {
    backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.base, height: 44, fontSize: fontSizes.body, color: colors.textPrimary,
  },
  inputError: { borderColor: colors.danger },
  errorText: { fontSize: fontSizes.caption, color: colors.danger, marginTop: -4 },
  skuHint: { fontSize: fontSizes.caption, color: colors.textMuted, marginTop: -4, marginBottom: 2 },
  skuDup: { fontSize: fontSizes.caption, color: colors.accent, fontWeight: '600', marginTop: -4, marginBottom: 2 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  doneBtn: { alignItems: 'center', paddingVertical: spacing.md },
  doneBtnText: { color: colors.textSecondary, fontSize: fontSizes.md, fontWeight: '600' },
});
