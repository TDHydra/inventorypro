import { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { generateUUID } from '../../utils/uuid';
import { upsertLocation } from '../../db/queries/locations';
import type { Location } from '../../db/queries/locations';
import { ensureVehicleRow, VEHICLE_MODEL_CATEGORY } from '../../db/queries/vehicles';
import { runInTransaction } from '../../db/tx';
import { getAllActiveUsers } from '../../db/queries/users';
import { TaxonomyChips } from '../pickers';
import { ROLE_DISPLAY_NAMES } from '../../constants/roles';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { getTheme } from '../../themes/store';
import { PrimaryButton } from '../ui/PrimaryButton';
import { FieldLabel } from '../ui/FieldLabel';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';
import { AdvancedFields } from '../ui/AdvancedFields';
import { track } from '../../telemetry';
import { validateName } from '../../lib/validation';

// A vehicle is just a location tagged type='Vehicle' (no separate table). This
// mirrors LocationQuickAdd but locks the type and offers an optional Owner instead
// of a parent. The inline "+ Create" path in the repair picker stays name-only.
const VEHICLE_ICON = '🚐';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

export default function VehicleQuickAdd({ onSaved }: Props) {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const nameRef = useRef<TextInput>(null);

  const [name, setName] = useState('');
  const [ownerOption, setOwnerOption] = useState<PickerOption | null>(null); // optional, sticky
  // vehicle_model taxonomy (#81) — optional, sticky like owner (fleets are
  // usually added a model at a time). id + label both kept (dual-write, #74).
  const [model, setModel] = useState<{ id: string | null; label: string | null }>({ id: null, label: null });
  const [nameError, setNameError] = useState('');

  const ownerOptions = useMemo<PickerOption[]>(
    () => getAllActiveUsers().map(u => ({ id: u.id, label: u.name, sublabel: ROLE_DISPLAY_NAMES[u.role] })),
    [],
  );

  function handleSave() {
    // Bounded, control-char-free name (same 'Name is required.' copy as before
    // for the blank case).
    const nameResult = validateName(name);
    if (!nameResult.ok) {
      track('audit', 'validation_reject', { screen: 'quick_add', props: { field: 'vehicle.name', rule: nameResult.rule } });
      setNameError(nameResult.error);
      return;
    }
    const trimmedName = nameResult.value;
    setNameError('');

    const now = new Date().toISOString();
    const id = generateUUID();

    const loc: Location = {
      id,
      name: trimmedName,
      parent_id: null,
      color: getTheme().colors.brand,
      icon: VEHICLE_ICON,
      owner_user_id: ownerOption?.id ?? null,
      active: 1,
      updated_at: now,
      synced_at: null,
      type: 'Vehicle',
    };

    // Atomic (#125): the location, its vehicles extension row (state/model),
    // both outbox entries, and the log land together or not at all.
    runInTransaction(() => {
      upsertLocation(loc);
      // synced_at is local-only — strip from the outbox payload (server has no such column).
      const { synced_at: _s, ...locRow } = loc;
      appendOutbox('INSERT', 'locations', { ...locRow, active: true });
      ensureVehicleRow(id, { model: model.label, model_id: model.id });
      appendLog({
        action: 'location_created',
        entity_type: 'location',
        entity_id: id,
        user_id: user?.id ?? null,
        team_id: null,
        job_id: null,
        note: trimmedName,
        from_location_id: null,
        to_location_id: null,
        quantity: null,
        unit: null,
        metadata: null,
        device_id: null,
      });
    });

    onSaved(trimmedName, id);
    setName(''); // clear name; keep owner sticky
    setTimeout(() => nameRef.current?.focus(), 100);
  }

  return (
    <View style={s.container}>
      <TextInput
        ref={nameRef}
        style={[s.input, !!nameError && s.inputError]}
        placeholder="Vehicle name *"
        placeholderTextColor={t.colors.textMuted}
        value={name}
        onChangeText={t => { setName(t); if (nameError) setNameError(''); }}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={handleSave}
      />
      {!!nameError && <Text style={s.errorText}>{nameError}</Text>}

      <TaxonomyChips
        category={VEHICLE_MODEL_CATEGORY}
        label="Model (optional)"
        deselectable
        valueId={model.id}
        valueLabel={model.label}
        onChange={setModel}
      />

      <AdvancedFields>
        <FieldLabel>Owner (optional)</FieldLabel>
        <SearchablePicker
          placeholder="Search people..."
          options={ownerOptions}
          value={ownerOption}
          onSelect={opt => setOwnerOption(prev => prev?.id === opt.id ? null : opt)}
        />
      </AdvancedFields>

      <PrimaryButton
        label="Save & add another"
        onPress={handleSave}
        disabled={locked}
        style={{ marginTop: t.spacing.md }}
      />
      {locked && <MaintenanceBanner />}
      <TouchableOpacity style={s.doneBtn} onPress={() => router.back()}>
        <Text style={s.doneBtnText}>Done</Text>
      </TouchableOpacity>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { gap: 10 },
  input: {
    backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base, height: 44, fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary,
  },
  inputError: { borderColor: t.colors.danger },
  errorText: { fontSize: t.typography.fontSizes.caption, color: t.colors.danger, marginTop: -4 },
  doneBtn: { alignItems: 'center', paddingVertical: t.spacing.md },
  doneBtnText: { color: t.colors.textSecondary, fontSize: t.typography.fontSizes.md, fontWeight: '600' },
});
