import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { EntityEditSheet } from '../ui/EntityEditSheet';
import { TextField } from '../ui/TextField';
import { Alert } from '../../lib/themedAlert';
import { useSession } from '../../hooks/useSession';
import { changePinOnline } from '../../auth/pin';
import { validatePinChange, PinChangeErrors } from './pinChangeLogic';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  visible: boolean;
  onClose: () => void;
}

/**
 * My Profile → Change PIN (role-dashboards spec §4). Current PIN + new PIN
 * twice; client pre-validation via validatePinChange (enrollment rules +
 * different-from-current + confirm match) with per-field errors, then
 * POST /me/change-pin. Online-only, like every PIN path — the PIN never
 * touches the device DB. A 403 (wrong current PIN) lands on the current-PIN
 * field; server 400 reasons (weak / same-as-current caught server-side) land
 * on the new-PIN field.
 */
export function ChangePinSheet({ visible, onClose }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const requiredLength = user?.pin_length_required ?? 4;

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<PinChangeErrors>({});

  // Fresh fields on every open — a PIN sheet must never reopen pre-filled.
  useEffect(() => {
    if (visible) {
      setCurrent(''); setNext(''); setConfirm(''); setErrors({});
    }
  }, [visible]);

  const handleSave = async () => {
    const clientErrors = validatePinChange(current, next, confirm, requiredLength);
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length > 0) throw new Error('validation');

    try {
      await changePinOnline(current, next);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not change PIN.';
      // Wrong current PIN → its own field; everything else the server rejects
      // about the NEW pin (weak, same-as-current, length policy) → that field.
      if (/current PIN/i.test(msg)) setErrors({ current: msg });
      else if (/connect/i.test(msg)) Alert.alert('You’re offline', msg);
      else setErrors({ next: msg });
      throw err; // keep the sheet open
    }
    Alert.alert('PIN changed', 'Use your new PIN the next time you sign in.');
  };

  return (
    <EntityEditSheet
      visible={visible}
      onClose={onClose}
      title="🔒 Change PIN"
      onSave={handleSave}
      saveLabel="Change PIN"
      disabled={!current || !next || !confirm}
    >
      <Text style={s.blurb}>
        Your PIN is {requiredLength} digits and is only ever checked on the server.
      </Text>
      <View style={s.fields}>
      <TextField
        label="Current PIN"
        value={current}
        onChangeText={setCurrent}
        error={errors.current}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={requiredLength}
        autoFocus
      />
      <TextField
        label="New PIN"
        value={next}
        onChangeText={setNext}
        error={errors.next}
        hint="No repeats (0000), sequences (1234), or common PINs."
        keyboardType="number-pad"
        secureTextEntry
        maxLength={requiredLength}
      />
      <TextField
        label="Confirm new PIN"
        value={confirm}
        onChangeText={setConfirm}
        error={errors.confirm}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={requiredLength}
      />
      </View>
    </EntityEditSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  fields: { gap: t.spacing.md },
  blurb: {
    fontSize: t.typography.fontSizes.body2,
    color: t.colors.textSecondary,
    marginBottom: t.spacing.base,
  },
});
