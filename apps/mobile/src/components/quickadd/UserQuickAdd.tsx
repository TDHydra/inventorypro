import { useState, useRef, useMemo } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import { useRouter } from 'expo-router';
import { createUserOnline, searchUsers, roleColor, getRoleColorMap } from '../../db/queries/users';
import { ROLE_DISPLAY_NAMES, UserRole } from '../../constants/roles';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { colors, spacing, radii, fontSizes } from '../../theme';
import { PrimaryButton } from '../ui/PrimaryButton';
import { FieldLabel } from '../ui/FieldLabel';
import { FilterChip } from '../ui/FilterChip';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';

const ALL_ROLES = Object.keys(ROLE_DISPLAY_NAMES) as UserRole[];
const DEFAULT_ROLE: UserRole = 'mitigation_technician';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

// Creating a user is ONLINE-ONLY (the server hashes a PIN the employee sets at
// first sign-in). We only collect name + role here — no PIN — exactly like the
// admin Users screen; see createUserOnline.
export default function UserQuickAdd({ onSaved }: Props) {
  const router = useRouter();
  const { user: sessionUser } = useSession();
  const { locked } = useMaintenanceMode();
  const nameRef = useRef<TextInput>(null);

  const [name, setName] = useState('');
  const [role, setRole] = useState<UserRole>(DEFAULT_ROLE); // sticky
  const [nameError, setNameError] = useState('');
  const [saving, setSaving] = useState(false);

  // Role colors for tinting matched names (built once).
  const roleColors = useMemo(() => getRoleColorMap(), []);

  // Live "already in the system?" search: as you type a name, surface existing
  // users so you can spot a duplicate before creating one. Names are tinted by
  // their role color (same as everywhere else).
  const nameMatches = useMemo(() => {
    const q = name.trim();
    if (q.length < 2) return [];
    return searchUsers(q, 6);
  }, [name]);

  async function handleSave() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Name is required.');
      return;
    }
    setNameError('');
    setSaving(true);
    try {
      const id = await createUserOnline(trimmedName, role);
      appendLog({
        action: 'user_created',
        entity_type: 'user',
        entity_id: id,
        user_id: sessionUser?.id ?? null,
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
    <View style={s.container}>
      <FieldLabel>Name</FieldLabel>
      <TextInput
        ref={nameRef}
        style={[s.input, !!nameError && s.inputError]}
        placeholder="Full name *"
        placeholderTextColor={colors.textMuted}
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

      <FieldLabel>Role</FieldLabel>
      <View style={s.chipWrap}>
        {ALL_ROLES.map(r => (
          <FilterChip
            key={r}
            label={ROLE_DISPLAY_NAMES[r]}
            active={role === r}
            onPress={() => setRole(r)}
          />
        ))}
      </View>

      <Text style={s.pinNote}>🔒 The employee sets their own PIN at first sign-in.</Text>

      <PrimaryButton
        label="Save & add another"
        onPress={handleSave}
        disabled={locked}
        loading={saving}
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
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  matches: { backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, marginTop: -2, overflow: 'hidden' },
  matchesHint: { fontSize: fontSizes.xs, color: colors.textMuted, fontWeight: '700', textTransform: 'uppercase', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 2 },
  matchRow: { paddingHorizontal: 12, paddingVertical: 9, borderTopWidth: 1, borderTopColor: colors.borderDetail, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  matchName: { fontSize: fontSizes.body2, fontWeight: '600', flex: 1 },
  matchSub: { fontSize: fontSizes.caption, color: colors.textMuted },
  inputError: { borderColor: colors.danger },
  errorText: { fontSize: fontSizes.caption, color: colors.danger, marginTop: -4 },
  pinNote: { fontSize: fontSizes.caption, color: colors.textMuted },
  doneBtn: { alignItems: 'center', paddingVertical: spacing.md },
  doneBtnText: { color: colors.textSecondary, fontSize: fontSizes.md, fontWeight: '600' },
});
