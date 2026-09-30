import { useEffect, useRef, useState } from 'react';
import { Animated, Modal, View, Text, Pressable, BackHandler, StyleSheet } from 'react-native';
import type { Theme } from '../themes/types';
import { useTheme } from '../hooks/useTheme';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { alertAnimations } from '../themes/motionPresets';
import { appAlertBus, type AlertButton, type AlertRequest } from './alertBus';

/**
 * Themed, in-app replacement for React Native's OS `Alert`.
 *
 * Drop-in: call sites swap `import { Alert } from 'react-native'` for
 * `import { Alert } from '../lib/themedAlert'` — the `.alert(title, message?,
 * buttons?)` signature matches RN's. A single `<AlertHost/>` mounted at the app
 * root renders the dialog so it inherits our colors, spacing and layout instead
 * of the bare OS popup.
 *
 * The queue/showing state machine lives in `alertBus.ts` (unit-tested, no RN
 * imports); this file is only the React renderer plus the RN-shaped facade.
 *
 * Presentation comes from `theme.components.alert`: 'fade'/'fade-scale' lean on
 * the Modal's native fade, 'slide-up'/'spring-pop' use animationType="none"
 * with a core-Animated driver (transform/opacity only, native driver).
 */

export type { AlertButton, AlertButtonStyle } from './alertBus';

/** Mirrors React Native's `Alert` API so call sites only change the import path. */
export const Alert = {
  alert(title: string, message?: string, buttons?: AlertButton[]): void {
    appAlertBus.alert({ title, message, buttons });
  },
};

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/** Mount once at the app root. Renders whatever the app alert bus delivers. */
export function AlertHost() {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);
  const [req, setReq] = useState<AlertRequest | null>(null);
  const closingRef = useRef(false);

  const { presentation, buttonLayout } = t.components.alert;
  const anims = alertAnimations[presentation];
  // 'fade'/'fade-scale' let the Modal fade the whole overlay; the other
  // presentations mount instantly and the driver fades/moves things itself.
  const fadesWithModal = presentation === 'fade' || presentation === 'fade-scale';
  const driver = useRef(new Animated.Value(anims.from)).current;

  useEffect(() => {
    appAlertBus.setListener(setReq);
    return () => { appAlertBus.setListener(null); };
  }, []);

  useEffect(() => {
    if (!req) return;
    closingRef.current = false;
    driver.setValue(anims.from);
    const anim = anims.enter(driver, t);
    anim.start();
    return () => anim.stop();
  }, [req, presentation]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (closingRef.current) return;
    const finish = () => {
      closingRef.current = false;
      setReq(null);
      // Run onPress AFTER the modal tears down. If a callback navigates (e.g.
      // "Add to Catalog" → router.push) while this <Modal> is still mounted, its
      // native window lingers on top of the pushed screen and swallows touches
      // until manually dismissed. Deferring to the next macrotask lets setReq(null)
      // commit and the modal close first — mirroring OS Alert, where onPress runs
      // after the dialog is gone.
      if (button?.onPress) setTimeout(button.onPress, 0);
      appAlertBus.notifyDismissed(); // surface the next queued request, if any
    };
    if (fadesWithModal) {
      finish();
      return;
    }
    // animationType="none": play the driver's exit so the overlay doesn't blink out.
    closingRef.current = true;
    anims.exit(driver, t).start(finish);
  }

  if (!req) return null;

  const stacked = req.buttons.length > 2 || buttonLayout === 'stacked';

  const cardAnim =
    presentation === 'fade-scale'
      ? { transform: [{ scale: driver.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }] }
      : presentation === 'slide-up'
        ? { transform: [{ translateY: driver.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }] }
        : presentation === 'spring-pop'
          ? { transform: [{ scale: driver.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] }
          : null;

  return (
    <Modal
      visible
      transparent
      animationType={fadesWithModal ? 'fade' : 'none'}
      onRequestClose={() => dismiss(cancelButton)}
    >
      {/* Tapping the dim backdrop cancels (only when a cancel button exists). */}
      <AnimatedPressable
        style={[s.backdrop, !fadesWithModal && { opacity: driver }]}
        onPress={() => cancelButton && dismiss(cancelButton)}
      >
        <Animated.View style={[s.cardWrap, cardAnim]}>
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
        </Animated.View>
      </AnimatedPressable>
    </Modal>
  );
}

function AlertActionButton({ button, stacked, onPress }: { button: AlertButton; stacked: boolean; onPress: () => void }) {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);
  const isCancel = button.style === 'cancel';
  const isDestructive = button.style === 'destructive';
  // Cancel is a quiet ghost button; default/destructive are filled (primary/danger).
  const bg = isCancel ? t.colors.surface : isDestructive ? t.colors.danger : t.colors.primary;
  const fg = isCancel ? t.colors.textSecondary : t.colors.onPrimary;
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

const makeStyles = (t: Theme) => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: t.colors.backdrop,
    alignItems: 'center',
    justifyContent: 'center',
    padding: t.spacing.xl,
  },
  cardWrap: {
    width: '100%',
    maxWidth: t.components.alert.maxWidth,
  },
  card: {
    width: '100%',
    backgroundColor: t.colors.surface,
    borderRadius: t.radii.card,
    padding: t.spacing.xl,
  },
  title: { fontSize: t.typography.fontSizes.lg, fontWeight: t.typography.weights.bold, color: t.colors.textPrimary },
  message: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, marginTop: t.spacing.sm, lineHeight: 20 },
  actions: { flexDirection: 'row', gap: t.spacing.sm, marginTop: t.spacing.xl },
  actionsStacked: { flexDirection: 'column-reverse' },
  btn: {
    minHeight: 46,
    borderRadius: t.radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: t.spacing.lg,
  },
  btnFlex: { flex: 1 },
  btnGhost: { borderWidth: 1, borderColor: t.colors.border },
  btnText: { fontSize: t.typography.fontSizes.base, fontWeight: t.typography.weights.bold },
});
