import { useEffect, useRef, useState } from 'react';
import { Animated, Text, StyleSheet } from 'react-native';
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
 */

const DEFAULT_DURATION_MS = 3000;

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
    timerRef.current = setTimeout(dismiss, req.durationMs ?? DEFAULT_DURATION_MS);
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

  // Bottom-anchored, above the safe area (so it clears a gesture nav bar/tab
  // bar the same way the dashboard's own bottom padding does).
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        s.wrap,
        {
          bottom: insets.bottom + t.spacing.lg,
          opacity: driver,
          transform: [{ translateY: driver.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
        },
      ]}
    >
      <Text style={s.text} numberOfLines={2}>{req.message}</Text>
    </Animated.View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: t.spacing.xl,
    right: t.spacing.xl,
    backgroundColor: t.colors.textPrimary,
    borderRadius: t.radii.lg,
    paddingVertical: t.spacing.md,
    paddingHorizontal: t.spacing.lg,
    alignItems: 'center',
    ...t.shadows.card,
  },
  text: {
    color: t.colors.background,
    fontSize: t.typography.fontSizes.body,
    fontWeight: t.typography.weights.semibold,
    textAlign: 'center',
  },
});
