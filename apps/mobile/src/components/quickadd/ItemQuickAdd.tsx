import { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { generateUUID } from '../../utils/uuid';
import { upsertItem } from '../../db/queries/items';
import type { InventoryItem } from '../../db/queries/items';
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
  const [itemType, setItemType] = useState<string>(''); // selected item_category label → category
  // unit_category stores a product_class id (drives formatQuantity decimals).
  const [unitCat, setUnitCat] = useState<string>(CLASS_PIECE_ID);
  const [unit, setUnit] = useState<string>(getUnitsForClass(CLASS_PIECE_ID)[0] ?? 'each');
  const [nameError, setNameError] = useState('');

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
    setItemType('');
    setUnitCat(CLASS_PIECE_ID);
    setUnit(getUnitsForClass(CLASS_PIECE_ID)[0] ?? 'each');
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
      sku: null,
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  doneBtn: { alignItems: 'center', paddingVertical: spacing.md },
  doneBtnText: { color: colors.textSecondary, fontSize: fontSizes.md, fontWeight: '600' },
});
