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
import { getProductClasses, getTaxonomyTypes } from '../../db/queries/taxonomy';
import { PRODUCT_CLASS_IDS } from '../../constants/units';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { colors, spacing, radii, fontSizes } from '../../theme';
import { PrimaryButton } from '../ui/PrimaryButton';
import { AppInput } from '../ui/AppInput';
import { FieldLabel } from '../ui/FieldLabel';
import { FilterChip } from '../ui/FilterChip';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';

// Pieces class id (migration 012) — the sensible default product unit class.
const CLASS_PIECE_ID = PRODUCT_CLASS_IDS.piece;

interface Props {
  onSaved: (label: string) => void;
}

export default function ItemQuickAdd({ onSaved }: Props) {
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const nameRef = useRef<TextInput>(null);

  // Configurable product (unit) classes; default to Pieces.
  const productClasses = useMemo(() => getProductClasses(), []);
  const pieceClass = productClasses.find(c => c.id === CLASS_PIECE_ID) ?? productClasses[0] ?? null;

  // Admin-managed Item Type taxonomy (PPE, Filters, Consumables, …) — the chosen
  // label is stored in the item's `category`. Equipment is NOT here; it has its
  // own tab. Items created here are always kind='product' so they show in Inventory.
  const itemTypes = useMemo(() => getTaxonomyTypes('item_category'), []);

  const [name, setName] = useState('');
  // unit_category stores a product_class id (stable taxonomy id).
  const [unitCat, setUnitCat] = useState<string>(pieceClass?.id ?? CLASS_PIECE_ID);
  const [unit, setUnit] = useState<string>(pieceClass?.units[0] ?? 'each');
  const [itemType, setItemType] = useState<string>(''); // selected item_category label → category
  const [nameError, setNameError] = useState('');

  function clearForm() {
    setName('');
    setUnitCat(pieceClass?.id ?? CLASS_PIECE_ID);
    setUnit(pieceClass?.units[0] ?? 'each');
    setItemType('');
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

  // Curated units for the selected class; empty → free-text unit entry.
  const selectedClass = productClasses.find(c => c.id === unitCat) ?? null;
  const unitOptions = selectedClass?.units ?? [];

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
                // Tap again to clear (item type is optional).
                onPress={() => setItemType(prev => (prev === t.label ? '' : t.label))}
              />
            ))}
          </View>
        </>
      )}

      <FieldLabel>Unit category</FieldLabel>
      <View style={s.chipRow}>
        {productClasses.map(c => (
          <FilterChip
            key={c.id}
            label={c.label}
            active={unitCat === c.id}
            onPress={() => { setUnitCat(c.id); setUnit(c.units[0] ?? ''); }}
          />
        ))}
      </View>
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
