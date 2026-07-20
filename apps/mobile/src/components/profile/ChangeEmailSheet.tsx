import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ModalSheet } from '../ui/ModalSheet';
import { FormActions } from '../ui/FormActions';
import { TextField } from '../ui/TextField';
import { Alert } from '../../lib/themedAlert';
import { useSession } from '../../hooks/useSession';
import { validateEmail } from '../../lib/validation';
import { requestEmailChangeCode, confirmEmailChange } from '../../api/me';
import { updateUserLocal } from '../../db/queries/users';
import { bumpDataVersion } from '../../sync/dataVersion';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  visible: boolean;
  onClose: () => void;
}

// enter  → type the new address (validateEmail) → POST /me/email/request-code
// code   → {sent:true}: enter the 6-digit code mailed to the NEW address
// retype → {sent:false} (SMTP unconfigured): type the address again to confirm
// Both terminal steps POST /me/email/confirm (with/without code) → 204.
type Step = 'enter' | 'code' | 'retype';

/**
 * My Profile → Change email (role-dashboards spec §4/§5). Multi-step, so it
 * composes ModalSheet + FormActions directly instead of EntityEditSheet (which
 * closes on every successful save — here only the LAST step closes). On
 * success the confirmed address is mirrored into the local users row (no
 * outbox — the server already committed it and bumped updated_at for sync).
 */
export function ChangeEmailSheet({ visible, onClose }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();

  const [step, setStep] = useState<Step>('enter');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [retyped, setRetyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Restart the flow on every open — a half-finished pending change on the
  // server is harmless (re-requesting replaces it).
  useEffect(() => {
    if (visible) {
      setStep('enter'); setEmail(''); setCode(''); setRetyped(''); setError(null);
    }
  }, [visible]);

  const finalize = async (withCode: boolean) => {
    await confirmEmailChange(email, withCode ? code.trim() : undefined);
    if (user) {
      updateUserLocal(user.id, { email });
      bumpDataVersion();
    }
    Alert.alert('Email updated', `Your email is now ${email}.`);
    onClose();
  };

  const handleSave = async () => {
    setError(null);
    setBusy(true);
    try {
      if (step === 'enter') {
        const v = validateEmail(email);
        if (!v.ok) { setError(v.error); return; }
        setEmail(v.value);
        const { sent } = await requestEmailChangeCode(v.value);
        setStep(sent ? 'code' : 'retype');
      } else if (step === 'code') {
        if (!/^\d{6}$/.test(code.trim())) { setError('Enter the 6-digit code from the email.'); return; }
        await finalize(true);
      } else {
        if (retyped.trim().toLowerCase() !== email.toLowerCase()) {
          setError('Addresses don’t match — type the new email exactly as before.');
          return;
        }
        await finalize(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const saveLabel = step === 'enter' ? 'Send code' : step === 'code' ? 'Confirm' : 'Save email';

  return (
    <ModalSheet visible={visible} onClose={onClose} scroll>
      <Text style={s.title}>📧 Change email</Text>
      <View style={s.fields}>
        {step === 'enter' && (
          <TextField
            label="New email"
            value={email}
            onChangeText={setEmail}
            error={error}
            hint="We’ll send a 6-digit confirmation code to this address."
            placeholder="name@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
        )}
        {step === 'code' && (
          <TextField
            label="Confirmation code"
            value={code}
            onChangeText={setCode}
            error={error}
            hint={`Enter the 6-digit code sent to ${email}.`}
            keyboardType="number-pad"
            maxLength={6}
            autoFocus
          />
        )}
        {step === 'retype' && (
          <TextField
            label="Confirm new email"
            value={retyped}
            onChangeText={setRetyped}
            error={error}
            hint={'Email codes aren’t available right now — type the new address again to confirm it.'}
            placeholder="name@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
          />
        )}
      </View>
      <FormActions onCancel={onClose} onSave={() => { void handleSave(); }} saveLabel={saveLabel} busy={busy} />
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  title: {
    fontSize: t.typography.fontSizes.lg,
    fontWeight: t.typography.weights.bold,
    color: t.colors.textPrimary,
    marginBottom: t.spacing.base,
  },
  fields: { gap: t.spacing.md },
});
