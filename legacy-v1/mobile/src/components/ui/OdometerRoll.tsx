import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated } from 'react-native';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  /** Full odometer reading, e.g. 52340. Negative/fractional input is floored to 0. */
  value: number;
  /**
   * Digit columns to render. Defaults to 6 (a physical odometer's wheel
   * count) but grows automatically if `value` needs more digits, so a real
   * reading is never truncated.
   */
  digits?: number;
}

const CELL_HEIGHT = 28;
const CELL_WIDTH = 20;
// 0-9 plus a duplicate '0' at index 10 — the extra glyph is what a 9→0
// rollover animates through before the driver snaps back to index 0.
const STRIP = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const STAGGER_MS = 40;

/**
 * Rolling-digit odometer readout (#175). One vertical strip per digit,
 * `overflow: hidden` cell + `Animated.timing` on `transform: translateY`
 * (`useNativeDriver: true`) moves the strip so the target glyph sits in the
 * window. Columns stagger left-to-right via `Animated.parallel` wrapping each
 * column in `Animated.sequence([Animated.delay(col * STAGGER_MS), timing])`.
 *
 * A digit that goes *down* (e.g. 9→0, or 8→2 after a jump) means it wrapped
 * forward past 9 rather than counting backward — an odometer never runs in
 * reverse. That case animates up to the duplicate '0' at strip index 10,
 * instantly snaps the driver back to index 0 (same glyph in the same window
 * position, so the snap is invisible), then — if the wrap didn't land
 * exactly on 0 — continues on to the real target digit.
 *
 * RN core `Animated` only; reanimated is not installed and must not be
 * added. When `t.motion.enabled` is false (Classic theme) digits snap into
 * place instantly with no animation.
 *
 * Usage: `<OdometerRoll value={vehicle.odometer} />` — re-render with a new
 * `value` (e.g. after a higher-odometer service record syncs in) to roll.
 */
export function OdometerRoll({ value, digits }: Props) {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);

  const safeValue = Math.max(0, Math.floor(value || 0));
  const raw = String(safeValue);
  const width = Math.max(digits ?? 6, raw.length);
  const digitChars = raw.padStart(width, '0').split('');
  const digitsKey = digitChars.join('');

  const anims = useRef<Animated.Value[]>([]);
  const prevDigits = useRef<number[]>([]);

  // Lazily (re)build the per-column drivers when the column count changes
  // (first mount, or a magnitude/`digits` change) — rare, so no transition.
  if (anims.current.length !== width) {
    anims.current = digitChars.map(d => new Animated.Value(Number(d)));
    prevDigits.current = digitChars.map(Number);
  }

  useEffect(() => {
    const targets = digitsKey.split('').map(Number);
    const changed = targets
      .map((target, col) => ({ target, col, from: prevDigits.current[col] ?? target }))
      .filter(({ target, from }) => target !== from);
    changed.forEach(({ target, col }) => { prevDigits.current[col] = target; });
    if (changed.length === 0) return;

    if (!t.motion.enabled) {
      changed.forEach(({ target, col }) => anims.current[col]?.setValue(target));
      return;
    }

    const runs = changed.map(({ from, target, col }) => {
      const anim = anims.current[col];
      const delay = Animated.delay(col * STAGGER_MS);
      const wrapped = target < from;
      if (!wrapped) {
        return Animated.sequence([
          delay,
          Animated.timing(anim, { toValue: target, duration: t.motion.duration.base, useNativeDriver: true }),
        ]);
      }
      return Animated.sequence([
        delay,
        Animated.timing(anim, { toValue: 10, duration: t.motion.duration.base, useNativeDriver: true }),
        Animated.timing(anim, { toValue: 0, duration: 0, useNativeDriver: true }),
        ...(target > 0
          ? [Animated.timing(anim, { toValue: target, duration: t.motion.duration.base, useNativeDriver: true })]
          : []),
      ]);
    });

    Animated.parallel(runs).start();
  }, [digitsKey, t.motion.enabled, t.motion.duration.base]);

  return (
    <View style={s.row} accessibilityRole="text" accessibilityLabel={`${safeValue.toLocaleString()} miles`}>
      {anims.current.map((anim, col) => {
        // Thin divider every 3 digits from the right (thousands grouping),
        // matching how the row below reads the same number with commas.
        const remaining = width - 1 - col;
        const showSeparator = remaining > 0 && remaining % 3 === 0;
        return (
          <View key={col} style={s.cellGroup}>
            <View style={s.cell}>
              <Animated.View style={{ transform: [{ translateY: Animated.multiply(anim, -CELL_HEIGHT) }] }}>
                {STRIP.map((ch, idx) => (
                  <Text key={idx} style={s.digit}>{ch}</Text>
                ))}
              </Animated.View>
            </View>
            {showSeparator && <View style={s.separator} />}
          </View>
        );
      })}
      <Text style={s.suffix}>mi</Text>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  cellGroup: { flexDirection: 'row', alignItems: 'center' },
  cell: {
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
    borderRadius: t.radii.sm,
    backgroundColor: t.colors.surfaceAlt,
    overflow: 'hidden',
    marginRight: 2,
  },
  digit: {
    height: CELL_HEIGHT,
    lineHeight: CELL_HEIGHT,
    textAlign: 'center',
    fontSize: t.typography.fontSizes.lg,
    fontFamily: t.typography.fontFamily.mono,
    color: t.colors.textStrong,
  },
  separator: {
    width: 1,
    height: CELL_HEIGHT * 0.6,
    backgroundColor: t.colors.border,
    marginRight: 3,
  },
  suffix: {
    marginLeft: t.spacing.xs,
    fontSize: t.typography.fontSizes.sm,
    color: t.colors.textSecondary,
  },
});
