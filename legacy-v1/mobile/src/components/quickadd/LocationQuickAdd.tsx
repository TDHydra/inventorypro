import { useState, useRef, useMemo } from 'react';
import { TextInput, StyleSheet } from 'react-native';
import { generateUUID } from '../../utils/uuid';
import { upsertLocation, getTopLevelLocations } from '../../db/queries/locations';
import type { Location } from '../../db/queries/locations';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { useDbQuery } from '../../hooks/useDbQuery';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { getTheme } from '../../themes/store';
import { FieldLabel } from '../ui/FieldLabel';
import { FormScreen } from '../ui/FormScreen';
import { AdvancedFields } from '../ui/AdvancedFields';
import { AutofillTextField } from '../ui/AutofillTextField';
import { QuickAddFooter } from './QuickAddFooter';
import { track } from '../../telemetry';
import { validateName } from '../../lib/validation';

const DEFAULT_ICON = '📦';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

export default function LocationQuickAdd({ onSaved }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();
  const nameRef = useRef<TextInput>(null);

  const [name, setName] = useState('');
  const [parentOption, setParentOption] = useState<PickerOption | null>(null); // sticky
  const [nameError, setNameError] = useState('');

  // Re-runs on any local write OR background sync pull touching locations
  // (#60/#63) — no manual refresh key needed.
  const topLevel = useDbQuery(() => getTopLevelLocations(), [], ['locations']);
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
      user_id: realUser?.id ?? null,
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
    // No explicit reload: appendOutbox's table bump (../../sync/outbox.ts) drives
    // the useDbQuery(['locations']) read above, refreshing the parent picker.
    setTimeout(() => nameRef.current?.focus(), 100);
  }

  return (
    // Owns its FormScreen (shell passes wrapForm={false}) so the Save/Done bar
    // sits in the sticky footer slot and floats above the keyboard (#118).
    <FormScreen
      contentContainerStyle={s.content}
      footer={<QuickAddFooter onSave={handleSave} disabled={locked} locked={locked} />}
    >
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
    </FormScreen>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // Mirrors the shell's default FormScreen content padding + this form's row gap.
  content: { padding: t.spacing.lg, paddingBottom: 48, gap: 10 },
});
