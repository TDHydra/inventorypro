import { useState } from 'react';
import { Modal, View, Text, StyleSheet } from 'react-native';
import { PINPad } from './PINPad';
import { verifyPinOnline } from '../auth/pin';
import { saveSession } from '../auth/session';
import { markReauthed } from '../auth/reauthTracker';
import type { Theme } from '../themes/types';
import { useTheme } from '../hooks/useTheme';
import { useThemedStyles } from '../hooks/useThemedStyles';

interface Props {
  visible: boolean;
  userId: string;
  userName: string;
  requiredLength: number;
}

/**
 * Full-screen, NON-dismissable PIN re-entry gate (#244 / idea 31). Rendered
 * by `app/(app)/_layout.tsx` whenever `useReauthRequired()` flips true. The
 * PIN model in this codebase is intentionally online-only (the bcrypt hash
 * never touches the device — see auth/pin.ts's header comment), so offline is
 * handled as "block and retry" rather than a fallback local check: the
 * session stays fully intact (no logout, no data loss) and the gate simply
 * waits for connectivity, exactly like the architect's decision for this unit.
 *
 * `onRequestClose` is a no-op and there is no backdrop/cancel affordance —
 * unlike `ModalSheet`, this must not be dismissable by tapping outside or the
 * Android back button, or the gate would be decorative.
 */
export function ReauthGate({ visible, userId, userName, requiredLength }: Props) {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(value: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await verifyPinOnline(userId, value);
      // Refresh the stored JWT/refresh token too — a re-auth is functionally
      // identical to a fresh /auth/token login, so it should extend the
      // session's refresh window exactly like a normal PIN entry would.
      await saveSession(result.jwt, result.refreshToken, result.userId);
      markReauthed();
      setPin('');
    } catch (err) {
      const msg = (err as Error).message;
      // Mirrors login.tsx submitPin's classification: a definitive server
      // rejection gets its own message; anything else (network unreachable,
      // timeout, etc.) is presented as a connectivity block-and-retry, never
      // a reason to log the user out or unlock the gate.
      const definitive = /Incorrect|inactive|expired|Too many/i.test(msg);
      setError(definitive ? msg : "Can't verify your PIN while offline. Check your connection and try again.");
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  function handleChange(next: string) {
    setPin(next);
    setError(null);
    if (next.length === requiredLength) {
      setTimeout(() => submit(next), 150);
    }
  }

  if (!visible) return null;

  return (
    <Modal visible transparent={false} animationType="fade" onRequestClose={() => {}}>
      <View style={s.container}>
        <Text style={s.lockIcon}>🔒</Text>
        <Text style={s.heading}>Session locked</Text>
        <Text style={s.sub}>
          {userName}, your role requires re-entering your PIN after a period of inactivity.
        </Text>
        <PINPad value={pin} onChange={handleChange} requiredLength={requiredLength} error={error} />
        {busy && <Text style={s.busy}>Verifying…</Text>}
      </View>
    </Modal>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background, alignItems: 'center', justifyContent: 'center', padding: 32 },
  lockIcon: { fontSize: 48, marginBottom: 16 },
  heading: { fontSize: 22, fontWeight: '700', color: t.colors.brand, marginBottom: 8 },
  sub: { fontSize: 14, color: t.colors.textSecondary, textAlign: 'center', marginBottom: 28, lineHeight: 19 },
  busy: { fontSize: 13, color: t.colors.textMuted, marginTop: 16 },
});
