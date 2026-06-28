import { useState, useRef, useEffect, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Switch,
} from 'react-native';
import { useRouter } from 'expo-router';
import { generateUUID } from '../../utils/uuid';
import { upsertItem } from '../../db/queries/items';
import type { InventoryItem } from '../../db/queries/items';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { getProductClasses } from '../../db/queries/taxonomy';
import { PRODUCT_CLASS_IDS } from '../../constants/units';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { colors, spacing, radii, fontSizes } from '../../theme';
import { PrimaryButton } from '../ui/PrimaryButton';
import { AppInput } from '../ui/AppInput';
import { FieldLabel } from '../ui/FieldLabel';
import { FilterChip } from '../ui/FilterChip';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';
import { AdvancedFields } from '../ui/AdvancedFields';

// Equipment is always pieces/each, so it stores the stable Pieces class id
// (migration 012) rather than a legacy enum string.
const CLASS_PIECE_ID = PRODUCT_CLASS_IDS.piece;

interface Props {
  onSaved: (label: string) => void;
}

export default function ItemQuickAdd({ onSaved }: Props) {
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const nameRef = useRef<TextInput>(null);

  // Configurable product classes (category 'product_class'); default to Pieces.
  const productClasses = useMemo(() => getProductClasses(), []);
  const pieceClass = productClasses.find(c => c.id === CLASS_PIECE_ID) ?? productClasses[0] ?? null;

  const [name, setName] = useState('');
  const [kind, setKind] = useState<'product' | 'equipment'>('product');
  // unit_category now stores a product_class id (stable taxonomy id), not a legacy enum.
  const [unitCat, setUnitCat] = useState<string>(pieceClass?.id ?? CLASS_PIECE_ID);
  const [unit, setUnit] = useState<string>(pieceClass?.units[0] ?? 'each');
  const [category, setCategory] = useState('');
  const [unitTracked, setUnitTracked] = useState(false);
  const [tagPrefix, setTagPrefix] = useState('');
  const [nameError, setNameError] = useState('');

  // When kind changes: lock unit for equipment; reset equipment fields for product
  useEffect(() => {
    if (kind === 'equipment') {
      setUnitCat(CLASS_PIECE_ID);
      setUnit('each');
    } else {
      setUnitTracked(false);
      setTagPrefix('');
    }
  }, [kind]);

  function clearForm() {
    setName('');
    setKind('product');
    setUnitCat(pieceClass?.id ?? CLASS_PIECE_ID);
    setUnit(pieceClass?.units[0] ?? 'each');
    setCategory('');
    setUnitTracked(false);
    setTagPrefix('');
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
    const isEquipment = kind === 'equipment';

    const item: InventoryItem = {
      id,
      name: trimmedName,
      barcode: null,
      description: null,
      sku: null,
      supplier: null,
      model: null,
      kind,
      category: category.trim() || null,
      returnable: 0,
      unit_tracked: isEquipment && unitTracked ? 1 : 0,
      tag_prefix: tagPrefix.trim() || null,
      unit_category: unitCat,
      unit,
      min_qty_alert: 0,
      reorder_to: null,
      active: 1,
      updated_at: now,
      synced_at: null,
    };

    upsertItem(item);
    // synced_at is a local-only column — the server table has none, and the
    // dynamic push INSERT would error on it. Strip it from the outbox payload.
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

      <FieldLabel>Kind</FieldLabel>
      <View style={s.chipRow}>
        {(['product', 'equipment'] as const).map(k => (
          <FilterChip
            key={k}
            label={k.charAt(0).toUpperCase() + k.slice(1)}
            active={kind === k}
            onPress={() => setKind(k)}
          />
        ))}
      </View>

      {kind === 'equipment' ? (
        <View style={s.unitReadOnlyRow}>
          <Text style={s.unitReadOnly}>Unit: each (piece)</Text>
        </View>
      ) : (
        <>
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
        </>
      )}

      <AdvancedFields>
        <AppInput
          placeholder="Category (optional)"
          value={category}
          onChangeText={setCategory}
        />

        {kind === 'equipment' && (
          <>
            <View style={s.switchRow}>
              <Text style={s.switchLabel}>Track individual units</Text>
              <Switch value={unitTracked} onValueChange={setUnitTracked} />
            </View>
            {unitTracked && (
              <AppInput
                placeholder="Tag prefix (e.g. AM-, DH-)"
                value={tagPrefix}
                onChangeText={setTagPrefix}
                autoCapitalize="characters"
              />
            )}
          </>
        )}
      </AdvancedFields>

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
  unitReadOnlyRow: { paddingVertical: spacing.xs },
  unitReadOnly: { fontSize: fontSizes.body, color: colors.textSecondary, fontStyle: 'italic' },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.base, paddingVertical: 10,
  },
  switchLabel: { fontSize: fontSizes.body, color: colors.textPrimary, flex: 1, marginRight: spacing.md },
  doneBtn: { alignItems: 'center', paddingVertical: spacing.md },
  doneBtnText: { color: colors.textSecondary, fontSize: fontSizes.md, fontWeight: '600' },
});
