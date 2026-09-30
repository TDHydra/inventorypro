import { useEffect, useRef, useState } from 'react';
import { Animated, Text, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '../themes/types';
import { useTheme } from '../hooks/useTheme';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { appToastBus, type ToastRequest } from '../lib/toastBus';

/**
 * Themed transient toast — the "show-but-locked" tap reason (#197: tapping a
 * disabled `PermissionGate` tile/button fires `toastBus.push({ message })`
 * with "Requires <permission label>") plus any other fire-and-forget status
 * message a call site wants to raise from non-React code.
 *
 * Mirrors `AlertHost`/`ConfirmSheetHost`'s wiring — a framework-free queue
 * (`createToastBus` in `toastBus.ts`) holds the queue/showing state; this file
 * only adds the React rendering on top — but a toast is DELIBERATELY never a
 * `Modal`: it must be able to surface over an already-open sheet/modal without
 * ever producing two visible overlays at once (backdrop dialogs count; a
 * bottom snackbar does not). It auto-dismisses on its own timer — there is no
 * user action required (and no buttons to press).
 *
 * Mount `<ToastHost />` once at the app root, alongside `<AlertHost />` /
 * `<ConfirmSheetHost />`.
 *
 * #203: a toast may carry a trailing `action` (e.g. "Request access") — a
 * plain `Pressable` at the trailing edge, NOT its own touchable surface that
 * dismisses on any tap (the toast otherwise stays a look-don't-touch status
 * strip). Tapping it runs `onPress` then dismisses. Auto-dismiss is extended
 * to ACTION_DURATION_MS while an action is present — a bare status message
 * ("Requires X") only needs to be read, but a button needs time to be
 * noticed AND tapped, so the 3s default would too often disappear on someone
 * mid-read/mid-reach. An explicit `durationMs` on the request always wins.
 */

const DEFAULT_DURATION_MS = 3000;
const ACTION_DURATION_MS = 6000;

export function ToastHost() {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const [req, setReq] = useState<ToastRequest | null>(null);
  const driver = useRef(new Animated.Value(0)).current;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    appToastBus.setListener(setReq);
    return () => { appToastBus.setListener(null); };
  }, []);

  useEffect(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (!req) return;
    driver.setValue(0);
    Animated.timing(driver, {
      toValue: 1,
      duration: t.motion.enabled ? t.motion.duration.fast : 0,
      useNativeDriver: true,
    }).start();
    timerRef.current = setTimeout(dismiss, req.durationMs ?? (req.action ? ACTION_DURATION_MS : DEFAULT_DURATION_MS));
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  function dismiss() {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    Animated.timing(driver, {
      toValue: 0,
      duration: t.motion.enabled ? t.motion.duration.fast : 0,
      useNativeDriver: true,
    }).start(() => {
      setReq(null);
      appToastBus.notifyDismissed(); // surface the next queued toast, if any
    });
  }

  if (!req) return null;

  const action = req.action;
  function runAction() {
    action?.onPress();
    dismiss();
  }

  // Bottom-anchored, above the safe area (so it clears a gesture nav bar/tab
  // bar the same way the dashboard's own bottom padding does).
  // pointerEvents: with no action, the whole strip stays a non-interactive
  // status readout (unchanged from pre-#203 behavior — nothing to tap, so
  // nothing intercepts touches meant for whatever's underneath). With an
  // action, the CONTAINER still lets touches pass through (`box-none`) — only
  // the action button itself (default pointerEvents) is tappable.
  const success = req.tone === 'success';
  return (
    <Animated.View
      pointerEvents={req.action ? 'box-none' : 'none'}
      style={[
        s.wrap,
        success && s.wrapSuccess,
        {
          bottom: insets.bottom + t.spacing.lg,
          opacity: driver,
          transform: [{ translateY: driver.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
        },
      ]}
    >
      {success && <Text style={s.successGlyph} accessibilityElementsHidden>✓</Text>}
      <Text
        style={[s.text, success && s.textSuccess, req.action && s.textWithAction]}
        numberOfLines={2}
      >
        {req.message}
      </Text>
      {req.action && (
        <Pressable
          onPress={runAction}
          hitSlop={8}
          style={s.actionBtn}
          accessibilityRole="button"
          accessibilityLabel={req.action.label}
        >
          <Text style={[s.actionText, success && s.actionTextSuccess]}>{req.action.label}</Text>
        </Pressable>
      )}
    </Animated.View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: t.spacing.xl,
    right: t.spacing.xl,
    flexDirection: 'row',
    backgroundColor: t.colors.textPrimary,
    borderRadius: t.radii.lg,
    paddingVertical: t.spacing.md,
    paddingHorizontal: t.spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: t.spacing.md,
    ...t.shadows.card,
  },
  text: {
    color: t.colors.background,
    fontSize: t.typography.fontSizes.body,
    fontWeight: t.typography.weights.semibold,
    textAlign: 'center',
  },
  // With an action present the message no longer centers alone — it takes the
  // remaining space to the left of the button and left-aligns (a centered
  // short message reads oddly once a button anchors the trailing edge).
  textWithAction: {
    flex: 1,
    textAlign: 'left',
  },
  actionBtn: {
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  actionText: {
    color: t.colors.accent,
    fontSize: t.typography.fontSizes.body,
    fontWeight: t.typography.weights.bold,
    textTransform: 'uppercase',
  },
  // tone: 'success' (#218 feedback) — a bold green confirmation strip, harder
  // to miss than the default dark toast. Text/action go surface-on-strong-color
  // (the PrimaryButton pattern) since the accent color can vanish on green.
  wrapSuccess: {
    backgroundColor: t.colors.success,
    paddingVertical: t.spacing.lg,
  },
  successGlyph: {
    color: t.colors.surface,
    fontSize: t.typography.fontSizes.lg,
    fontWeight: t.typography.weights.bold,
  },
  textSuccess: {
    color: t.colors.surface,
    fontSize: t.typography.fontSizes.base,
    fontWeight: t.typography.weights.bold,
  },
  actionTextSuccess: {
    color: t.colors.surface,
    textDecorationLine: 'underline',
  },
});
