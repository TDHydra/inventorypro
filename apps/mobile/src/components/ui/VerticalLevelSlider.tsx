import { useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, PanResponder, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { KIT_HIT_SLOP } from './hitSlop';

interface Props {
  /** Committed value 0–100 (shown when not dragging). */
  value: number;
  /** Fired on release with the raw (unsnapped) 0–100 position. */
  onCommit: (rawPct: number) => void;
  disabled?: boolean;
}

/**
 * Vertical drag-to-fill level control (#152 debris). Pure PanResponder — no
 * native module, web-safe (precedent: DragList). The fill tracks the finger
 * continuously; the caller decides how to quantize the committed value.
 */
export function VerticalLevelSlider({ value, onCommit, disabled }: Props) {
  const s = useThemedStyles(makeStyles);
  const [drag, setDrag] = useState<number | null>(null);
  // Refs, not state, inside the responder: setState is async and the once-
  // created responder must always read current values (DragList pattern).
  const cfg = useRef({ disabled: !!disabled, onCommit });
  cfg.current = { disabled: !!disabled, onCommit };
  const dragRef = useRef<number | null>(null);
  const heightRef = useRef(1);
  const grantPct = useRef(0);

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !cfg.current.disabled,
    onMoveShouldSetPanResponder: () => !cfg.current.disabled,
    onPanResponderGrant: evt => {
      const pct = clampPct(100 * (1 - evt.nativeEvent.locationY / heightRef.current));
      grantPct.current = pct;
      dragRef.current = pct;
      setDrag(pct);
    },
    onPanResponderMove: (_e, g) => {
      const pct = clampPct(grantPct.current - (g.dy / heightRef.current) * 100);
      dragRef.current = pct;
      setDrag(pct);
    },
    onPanResponderRelease: () => {
      const v = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (v != null) cfg.current.onCommit(v);
    },
    onPanResponderTerminate: () => { dragRef.current = null; setDrag(null); },
  }), []);

  const display = drag ?? clampPct(value);
  // #221: coarse nudge for anyone who can't land the drag (gloves, screen
  // readers). Buttons commit directly; the adjustable role + actions cover
  // the assistive-tech path on the track itself.
  const nudge = (delta: number) => {
    if (cfg.current.disabled) return;
    cfg.current.onCommit(clampPct(clampPct(value) + delta));
  };
  return (
    <View style={s.row}>
      <View
        style={[s.track, disabled && s.trackDisabled]}
        onLayout={e => { heightRef.current = Math.max(1, e.nativeEvent.layout.height); }}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel="Level"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(display) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={e => nudge(e.nativeEvent.actionName === 'increment' ? 5 : -5)}
        {...responder.panHandlers}
      >
        <View style={[s.fill, { height: `${display}%` }]} />
      </View>
      <View style={s.side}>
        <Pressable
          onPress={() => nudge(5)}
          disabled={disabled || display >= 100}
          hitSlop={KIT_HIT_SLOP}
          style={s.nudgeBtn}
          accessibilityRole="button"
          accessibilityLabel="Increase level"
          accessibilityState={{ disabled: disabled || display >= 100 }}
        >
          <Text style={[s.nudgeText, (disabled || display >= 100) && s.nudgeTextDisabled]}>＋</Text>
        </Pressable>
        <Text style={s.pct}>{Math.round(display)}%</Text>
        <Pressable
          onPress={() => nudge(-5)}
          disabled={disabled || display <= 0}
          hitSlop={KIT_HIT_SLOP}
          style={s.nudgeBtn}
          accessibilityRole="button"
          accessibilityLabel="Decrease level"
          accessibilityState={{ disabled: disabled || display <= 0 }}
        >
          <Text style={[s.nudgeText, (disabled || display <= 0) && s.nudgeTextDisabled]}>−</Text>
        </Pressable>
      </View>
    </View>
  );
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

const makeStyles = (t: Theme) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: t.spacing.md },
  side: { alignItems: 'center', gap: t.spacing.xs },
  nudgeBtn: {
    width: 36, height: 36, borderRadius: t.radii.md, borderWidth: 1,
    borderColor: t.colors.border, backgroundColor: t.colors.surface,
    alignItems: 'center', justifyContent: 'center',
  },
  nudgeText: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.primaryText },
  nudgeTextDisabled: { color: t.colors.textDisabled },
  track: {
    width: 44,
    height: 140,
    borderRadius: t.radii.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.background,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  trackDisabled: { opacity: 0.5 },
  fill: { width: '100%', backgroundColor: t.colors.primaryBg },
  pct: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textSecondary, marginBottom: t.spacing.xs },
});
