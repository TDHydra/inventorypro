import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated, StyleSheet, Text, TouchableOpacity,
  type StyleProp, type ViewStyle,
} from 'react-native';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { KIT_HIT_SLOP } from './hitSlop';

interface Props {
  /** Body copy. The caller decides *whether* a hint is due; this only draws it. */
  text: string;
  /**
   * Fired synchronously the moment dismissal starts — before the exit
   * animation, so a caller persisting "seen" cannot lose the write if the
   * screen unmounts mid-fade.
   */
  onDismiss?: () => void;
  /** ms until it dismisses itself. Omit to stay until ✕ is pressed. */
  autoDismissMs?: number;
  style?: StyleProp<ViewStyle>;
}

/**
 * The inline, in-flow hint strip (💡 copy + ✕) that mobile's TooltipHint shows
 * once per screen. A sibling of OfflineBanner/MaintenanceBanner: presentation
 * only, no persistence and no knowledge of who is allowed to see what.
 *
 * It owns its own visibility so the exit fade can finish, and it owns the
 * auto-dismiss timer — which is the point. That timer previously lived in the
 * app component with no cleanup, so navigating away inside the window fired a
 * state update *and* a settings write from a dead component (the page render
 * tests caught it as a crashed jest worker). Here it is cleared on unmount and
 * before any reschedule.
 */
export function HintBanner({ text, onDismiss, autoDismissMs, style }: Props) {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);
  // Classic flattens non-essential animation, so there is nothing to fade from.
  const opacity = useRef(new Animated.Value(t.motion.enabled ? 0 : 1)).current;
  const [hidden, setHidden] = useState(false);
  const dismissing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  // The timer and the animation callback both outlive a render, so they read the
  // latest onDismiss through a ref rather than capturing the first one.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => { onDismissRef.current = onDismiss; }, [onDismiss]);

  const dismiss = useCallback(() => {
    if (dismissing.current) return; // ✕ racing the timer, or a double tap
    dismissing.current = true;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    onDismissRef.current?.();
    if (!t.motion.enabled) { setHidden(true); return; }
    Animated.timing(opacity, {
      toValue: 0, duration: t.motion.duration.fast, useNativeDriver: true,
    }).start(() => { if (mounted.current) setHidden(true); });
  }, [opacity, t.motion.enabled, t.motion.duration.fast]);

  useEffect(() => {
    mounted.current = true;
    if (t.motion.enabled) {
      Animated.timing(opacity, {
        toValue: 1, duration: t.motion.duration.fast, useNativeDriver: true,
      }).start();
    }
    if (autoDismissMs != null) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(dismiss, autoDismissMs);
    }
    return () => {
      mounted.current = false;
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    };
  }, [autoDismissMs, dismiss, opacity, t.motion.enabled, t.motion.duration.fast]);

  if (hidden) return null;

  return (
    <Animated.View style={[s.banner, { opacity }, style]}>
      <Text style={s.icon}>💡</Text>
      <Text style={s.text}>{text}</Text>
      <TouchableOpacity
        onPress={dismiss}
        style={s.close}
        hitSlop={KIT_HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel="Dismiss hint"
      >
        <Text style={s.closeText}>✕</Text>
      </TouchableOpacity>
    </Animated.View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: t.colors.primaryBg,
    borderRadius: t.radii.card,
    borderWidth: 1,
    borderColor: t.colors.primaryBgStrong,
    padding: t.spacing.md,
    gap: t.spacing.sm,
    marginHorizontal: t.spacing.md,
    marginBottom: t.spacing.sm,
  },
  icon: { fontSize: t.typography.fontSizes.base },
  text: {
    flex: 1,
    fontSize: t.typography.fontSizes.body2,
    color: t.colors.primaryText,
    lineHeight: Math.round(t.typography.fontSizes.body2 * 1.45),
  },
  close: { paddingLeft: t.spacing.sm },
  closeText: { color: t.colors.textMuted, fontSize: t.typography.fontSizes.md },
});
