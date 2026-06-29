import { useEffect, useState } from 'react';
import { Modal, View, Text, Pressable, BackHandler, StyleSheet } from 'react-native';
import { colors, radii, spacing, fontSizes } from '../theme';

/**
 * Themed, in-app replacement for React Native's OS `Alert`.
 *
 * Drop-in: call sites swap `import { Alert } from 'react-native'` for
 * `import { Alert } from '../lib/themedAlert'` — the `.alert(title, message?,
 * buttons?)` signature matches RN's. A single `<AlertHost/>` mounted at the app
 * root renders the dialog so it inherits our colors, spacing and layout instead
 * of the bare OS popup.
 */

export type AlertButtonStyle = 'default' | 'cancel' | 'destructive';
export interface AlertButton {
  text?: string;
  onPress?: () => void;
  style?: AlertButtonStyle;
}
interface AlertRequest {
  title: string;
  message?: string;
  buttons: AlertButton[];
}

type Listener = (req: AlertRequest | null) => void;
let listener: Listener | null = null;
let showing = false;
// Requests raised before the host mounts (or while one is showing) wait here.
const queue: AlertRequest[] = [];

function pump(): void {
  if (showing || !listener || queue.length === 0) return;
  showing = true;
  listener(queue.shift()!);
}

function normalize(buttons?: AlertButton[]): AlertButton[] {
  if (!buttons || buttons.length === 0) return [{ text: 'OK', style: 'default' }];
  return buttons;
}

/** Mirrors React Native's `Alert` API so call sites only change the import path. */
export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[]): void {
    queue.push({ title, message, buttons: normalize(buttons) });
    pump();
  },
};

/** Mount once at the app root. Renders whatever `Alert.alert` requests. */
export function AlertHost() {
  const [req, setReq] = useState<AlertRequest | null>(null);

  useEffect(() => {
    listener = setReq;
    pump(); // drain anything raised before we mounted
    return () => { listener = null; };
  }, []);

  const cancelButton = req?.buttons.find((b) => b.style === 'cancel');

  // Android back press behaves like tapping cancel (or closes if none).
  useEffect(() => {
    if (!req) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      dismiss(cancelButton);
      return true;
    });
    return () => sub.remove();
  }, [req]); // eslint-disable-line react-hooks/exhaustive-deps

  function dismiss(button?: AlertButton) {
    setReq(null);
    showing = false;
    // Run onPress AFTER the modal tears down. If a callback navigates (e.g.
    // "Add to Catalog" → router.push) while this <Modal> is still mounted, its
    // native window lingers on top of the pushed screen and swallows touches
    // until manually dismissed. Deferring to the next macrotask lets setReq(null)
    // commit and the modal close first — mirroring OS Alert, where onPress runs
    // after the dialog is gone.
    if (button?.onPress) setTimeout(button.onPress, 0);
    pump(); // surface the next queued request, if any
  }

  if (!req) return null;

  const stacked = req.buttons.length > 2;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => dismiss(cancelButton)}>
      {/* Tapping the dim backdrop cancels (only when a cancel button exists). */}
      <Pressable style={s.backdrop} onPress={() => cancelButton && dismiss(cancelButton)}>
        {/* Swallow presses on the card itself. */}
        <Pressable style={s.card} onPress={() => {}}>
          <Text style={s.title}>{req.title}</Text>
          {!!req.message && <Text style={s.message}>{req.message}</Text>}
          <View style={[s.actions, stacked && s.actionsStacked]}>
            {req.buttons.map((b, i) => (
              <AlertActionButton key={i} button={b} stacked={stacked} onPress={() => dismiss(b)} />
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function AlertActionButton({ button, stacked, onPress }: { button: AlertButton; stacked: boolean; onPress: () => void }) {
  const isCancel = button.style === 'cancel';
  const isDestructive = button.style === 'destructive';
  // Cancel is a quiet ghost button; default/destructive are filled (primary/danger).
  const bg = isCancel ? colors.surface : isDestructive ? colors.danger : colors.primary;
  const fg = isCancel ? colors.textSecondary : '#fff';
  return (
    <Pressable
      style={({ pressed }) => [
        s.btn,
        !stacked && s.btnFlex,
        { backgroundColor: bg },
        isCancel && s.btnGhost,
        pressed && { opacity: 0.8 },
      ]}
      onPress={onPress}
    >
      <Text style={[s.btnText, { color: fg }]} numberOfLines={1}>{button.text ?? 'OK'}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 380,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    padding: spacing.xl,
  },
  title: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.textPrimary },
  message: { fontSize: fontSizes.body, color: colors.textSecondary, marginTop: spacing.sm, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl },
  actionsStacked: { flexDirection: 'column-reverse' },
  btn: {
    minHeight: 46,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  btnFlex: { flex: 1 },
  btnGhost: { borderWidth: 1, borderColor: colors.border },
  btnText: { fontSize: fontSizes.base, fontWeight: '700' },
});
