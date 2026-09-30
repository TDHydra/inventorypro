import { useState, useRef, useMemo } from 'react';
import { View, Text, TextInput, StyleSheet } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import { createUserOnline, searchUsers, roleColor, getRoleColorMap } from '../../db/queries/users';
import { ROLE_DISPLAY_NAMES, UserRole } from '../../constants/roles';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { useTableVersion } from '../../hooks/useDataVersion';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { FieldLabel } from '../ui/FieldLabel';
import { FormScreen } from '../ui/FormScreen';
import { SelectField } from '../ui/SelectField';
import { QuickAddFooter } from './QuickAddFooter';
import { track } from '../../telemetry';
import { validateName } from '../../lib/validation';

const ALL_ROLES = Object.keys(ROLE_DISPLAY_NAMES) as UserRole[];
const DEFAULT_ROLE: UserRole = 'mitigation_technician';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

// Creating a user is ONLINE-ONLY (the server hashes a PIN the employee sets at
// first sign-in). We only collect name + role here — no PIN — exactly like the
// admin Users screen; see createUserOnline.
export default function UserQuickAdd({ onSaved }: Props) {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { user: sessionUser, realUser } = useSession();
  const { locked } = useMaintenanceMode();
  const nameRef = useRef<TextInput>(null);

  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>(DEFAULT_ROLE); // sticky
  const [nameError, setNameError] = useState('');
  const [saving, setSaving] = useState(false);

  // Role colors for tinting matched names (re-read when role_settings changes).
  const roleSettingsVersion = useTableVersion(['role_settings']);
  const roleColors = useMemo(() => getRoleColorMap(), [roleSettingsVersion]);

  // Live "already in the system?" search: as you type a name, surface existing
  // users so you can spot a duplicate before creating one. Names are tinted by
  // their role color (same as everywhere else).
  const nameMatches = useMemo(() => {
    const q = name.trim();
    if (q.length < 2) return [];
    return searchUsers(q, 6);
  }, [name]);

  async function handleSave() {
    // Bounded, control-char-free name (same 'Name is required.' copy as before
    // for the blank case).
    const nameResult = validateName(name);
    if (!nameResult.ok) {
      track('audit', 'validation_reject', { screen: 'quick_add', props: { field: 'user.name', rule: nameResult.rule } });
      setNameError(nameResult.error);
      return;
    }
    const trimmedName = nameResult.value;
    setNameError('');
    setSaving(true);
    try {
      const id = await createUserOnline(trimmedName, role);
      appendLog({
        action: 'user_created',
        entity_type: 'user',
        entity_id: id,
        user_id: realUser?.id ?? null,
        team_id: null,
        job_id: null,
        note: `${trimmedName} (${role})`,
        from_location_id: null,
        to_location_id: null,
        quantity: null,
        unit: null,
        metadata: null,
        device_id: null,
      });
      onSaved(trimmedName, id);
      setName(''); // keep role sticky for rapid entry
      setTimeout(() => nameRef.current?.focus(), 100);
    } catch (e) {
      Alert.alert('Could not create user', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    // Owns its FormScreen (shell passes wrapForm={false}) so the Save/Done bar
    // sits in the sticky footer slot and floats above the keyboard (#118).
    <FormScreen
      contentContainerStyle={s.content}
      footer={
        <QuickAddFooter onSave={handleSave} disabled={locked} loading={saving} locked={locked} />
      }
    >
      <FieldLabel>Name</FieldLabel>
      <TextInput
        ref={nameRef}
        style={[s.input, !!nameError && s.inputError]}
        placeholder="Full name *"
        placeholderTextColor={t.colors.textMuted}
        value={name}
        onChangeText={t => { setName(t); if (nameError) setNameError(''); }}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={handleSave}
      />
      {!!nameError && <Text style={s.errorText}>{nameError}</Text>}

      {nameMatches.length > 0 && (
        <View style={s.matches}>
          <Text style={s.matchesHint}>Already in the system?</Text>
          {nameMatches.map(u => (
            <View key={u.id} style={s.matchRow}>
              <Text style={[s.matchName, { color: roleColor(u.role, roleColors) }]} numberOfLines={1}>{u.name}</Text>
              <Text style={s.matchSub}>{ROLE_DISPLAY_NAMES[u.role]}</Text>
            </View>
          ))}
        </View>
      )}

      <SelectField
        label="Role"
        value={role}
        options={ALL_ROLES.map(r => ({ id: r, label: ROLE_DISPLAY_NAMES[r] }))}
        onSelect={id => setRole(id as UserRole)}
      />

      <Text style={s.pinNote}>🔒 The employee sets their own PIN at first sign-in.</Text>
    </FormScreen>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // Mirrors the shell's default FormScreen content padding + this form's row gap.
  content: { padding: t.spacing.lg, paddingBottom: 48, gap: 10 },
  input: {
    backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base, height: 44, fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary,
  },
  matches: { backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border, marginTop: -2, overflow: 'hidden' },
  matchesHint: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted, fontWeight: '700', textTransform: 'uppercase', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 },
  matchRow: { paddingHorizontal: 12, paddingVertical: 9, borderTopWidth: 1, borderTopColor: t.colors.borderDetail, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  matchName: { fontSize: t.typography.fontSizes.body2, fontWeight: '600', flex: 1 },
  matchSub: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted },
  inputError: { borderColor: t.colors.danger },
  errorText: { fontSize: t.typography.fontSizes.caption, color: t.colors.danger, marginTop: -4 },
  pinNote: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted },
});
