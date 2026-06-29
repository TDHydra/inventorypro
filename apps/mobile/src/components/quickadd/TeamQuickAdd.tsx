import { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { generateUUID } from '../../utils/uuid';
import { upsertTeam } from '../../db/queries/teams';
import type { Team } from '../../db/queries/teams';
import { getAllActiveUsers } from '../../db/queries/users';
import { getTaxonomyTypes } from '../../db/queries/taxonomy';
import { renderIcon } from '../../constants/locationStyles';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';
import { colors, spacing, radii, fontSizes } from '../../theme';
import { AppInput } from '../ui/AppInput';
import { FieldLabel } from '../ui/FieldLabel';
import { FilterChip } from '../ui/FilterChip';
import { PrimaryButton } from '../ui/PrimaryButton';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

export default function TeamQuickAdd({ onSaved }: Props) {
  const router = useRouter();
  const { user } = useSession();
  const { locked } = useMaintenanceMode();

  const teamTypes = useMemo(() => getTaxonomyTypes('team'), []);
  const managerOptions: PickerOption[] = useMemo(
    () => getAllActiveUsers().map(u => ({ id: u.id, label: u.name })),
    [],
  );

  const [name, setName] = useState('');
  const [type, setType] = useState(() => teamTypes[0]?.label ?? '');
  const [managerOption, setManagerOption] = useState<PickerOption | null>(null); // sticky
  const [nameError, setNameError] = useState('');

  function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Name is required.');
      return;
    }
    setNameError('');

    const now = new Date().toISOString();
    const id = generateUUID();
    const managerId = managerOption?.id ?? null;

    const team: Team = {
      id,
      name: trimmedName,
      type,
      manager_id: managerId,
      updated_at: now,
      synced_at: null,
    };

    upsertTeam(team);
    // synced_at is local-only — strip from the outbox payload (server has no such column).
    const { synced_at: _s, ...teamRow } = team;
    appendOutbox('INSERT', 'teams', { ...teamRow });
    appendLog({
      action: 'team_created',
      entity_type: 'team',
      entity_id: id,
      user_id: user?.id ?? null,
      team_id: id,
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
    setName(''); // clear name; keep type + manager sticky
  }

  return (
    <View style={s.container}>
      <AppInput
        style={!!nameError && s.inputError}
        placeholder="Team name *"
        value={name}
        onChangeText={t => { setName(t); if (nameError) setNameError(''); }}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={handleSave}
      />
      {!!nameError && <Text style={s.errorText}>{nameError}</Text>}

      <FieldLabel>Type</FieldLabel>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.chipRow}
      >
        {teamTypes.map(t => (
          <FilterChip
            key={t.label}
            label={`${renderIcon(t.icon)} ${t.label}`}
            active={type === t.label}
            onPress={() => setType(t.label)}
          />
        ))}
      </ScrollView>

      <FieldLabel>Manager (optional)</FieldLabel>
      <SearchablePicker
        placeholder="Search users..."
        options={managerOptions}
        value={managerOption}
        onSelect={opt => setManagerOption(prev => prev?.id === opt.id ? null : opt)}
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
  inputError: { borderColor: colors.danger },
  errorText: { fontSize: fontSizes.caption, color: colors.danger, marginTop: -4 },
  chipRow: { gap: 8, paddingRight: 8 },
  doneBtn: { alignItems: 'center', paddingVertical: spacing.md },
  doneBtnText: { color: colors.textSecondary, fontSize: fontSizes.md, fontWeight: '600' },
});
