import { useState, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { generateUUID } from '../../utils/uuid';
import { upsertLocation, getTopLevelLocations } from '../../db/queries/locations';
import type { Location } from '../../db/queries/locations';
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
import { AutofillTextField } from '../ui/AutofillTextField';
import { track } from '../../telemetry';
import { validateName } from '../../lib/validation';

const DEFAULT_ICON = '📦';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

export default function LocationQuickAdd({ onSaved }: Props) {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const nameRef = useRef<TextInput>(null);

  const [name, setName] = useState('');
  const [parentOption, setParentOption] = useState<PickerOption | null>(null); // sticky
  const [nameError, setNameError] = useState('');
  // Increment to trigger a re-fetch of top-level locations after each save
  const [refreshKey, setRefreshKey] = useState(0);

  const topLevel = useMemo(() => getTopLevelLocations(), [refreshKey]);
  const parentOptions: PickerOption[] = useMemo(
    () => topLevel.map(l => ({ id: l.id, label: l.name })),
    [topLevel],
  );

  function handleSave() {
    track('action', 'quickadd_save_location', { screen: 'quick_add' });
    // Bounded, control-char-free name (same 'Name is required.' copy as before
    // for the blank case).
    const nameResult = validateName(name);
    if (!nameResult.ok) {
      track('audit', 'validation_reject', { screen: 'quick_add', props: { field: 'location.name', rule: nameResult.rule } });
      setNameError(nameResult.error);
      return;
    }
    const trimmedName = nameResult.value;
    setNameError('');

    const now = new Date().toISOString();
    const id = generateUUID();
    const parentId = parentOption?.id ?? null;

    const loc: Location = {
      id,
      name: trimmedName,
      parent_id: parentId,
      color: getTheme().colors.brand,
      icon: DEFAULT_ICON,
      owner_user_id: null,
      active: 1,
      updated_at: now,
      synced_at: null,
    };

    upsertLocation(loc);
    // synced_at is local-only — strip from the outbox payload (server has no such column).
    const { synced_at: _s, ...locRow } = loc;
    appendOutbox('INSERT', 'locations', { ...locRow, active: true });
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

    onSaved(trimmedName, id);
    setName(''); // clear name; keep parent sticky
    setRefreshKey(k => k + 1); // refresh parent picker with newly added locations
    setTimeout(() => nameRef.current?.focus(), 100);
  }

  return (
    <View style={s.container}>
      <AutofillTextField
        label="Location name"
        required
        table="locations"
        column="name"
        placeholder="Enter location name"
        value={name}
        onChangeText={t => { setName(t); if (nameError) setNameError(''); }}
        error={nameError}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={handleSave}
        inputRef={nameRef}
      />

      <AdvancedFields>
        <FieldLabel>Parent location (optional)</FieldLabel>
        <SearchablePicker
          placeholder="Search parent locations..."
          options={parentOptions}
          value={parentOption}
          onSelect={opt => setParentOption(prev => prev?.id === opt.id ? null : opt)}
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
  doneBtn: { alignItems: 'center', paddingVertical: t.spacing.md },
  doneBtnText: { color: t.colors.textSecondary, fontSize: t.typography.fontSizes.md, fontWeight: '600' },
});
