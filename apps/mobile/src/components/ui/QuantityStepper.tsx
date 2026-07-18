import { useEffect, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View, StyleSheet, type ReturnKeyTypeOptions } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { Field } from './Field';
import { clampQuantity, parseQuantityInput } from './quantityMath';

export { clampQuantity, parseQuantityInput } from './quantityMath';

// Numeric quantity input with − / + steppers, long-press repeat, and
// min/max clamping — for stock counts, pack sizes, repair part quantities.
//
// Usage:
//   <QuantityStepper value={qty} onChange={setQty} min={0} max={999} unit="ea" />
//   <QuantityStepper value={qty} onChange={setQty} label="Quantity" allowDecimal step={0.5} />

interface Props {
  value: number;
  onChange: (n: number) => void;
  min?: number; // default 0
  max?: number;
  step?: number; // default 1
  unit?: string; // rendered as a muted suffix, e.g. 'ea', 'ft'
  label?: string; // optional Field wrapper when provided
  allowDecimal?: boolean; // default false
  size?: 'sm' | 'md'; // default 'md' (md = 44px row height, matches AppInput)
  // Fired on the keyboard submit key with the just-committed (clamped/parsed)
  // value — parent state set via onChange is still stale at this point.
  onSubmitEditing?: (committed: number) => void;
  returnKeyType?: ReturnKeyTypeOptions;
}

const REPEAT_INTERVAL_MS = 120;

function formatQuantity(n: number): string {
  return String(n);
}

export function QuantityStepper({
  value,
  onChange,
  min = 0,
  max,
  step = 1,
  unit,
  label,
  allowDecimal = false,
  size = 'md',
  onSubmitEditing,
  returnKeyType,
}: Props) {
  const s = useThemedStyles(makeStyles);
  const [text, setText] = useState(formatQuantity(value));
  const editingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Long-press ramp reads from this ref (updated every render) instead of
  // closing over the `value` prop — a setInterval callback created once at
  // press-start would otherwise keep recomputing off the stale render-time
  // value and the ramp would step once then freeze.
  const valueRef = useRef(value);
  valueRef.current = value;

  // Keep the local text in sync with external value changes while the user
  // isn't mid-edit (avoids clobbering keystrokes on a controlled re-render).
  useEffect(() => {
    if (!editingRef.current) setText(formatQuantity(value));
  }, [value]);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) clearInterval(timerRef.current);
    };
  }, []);

  const clearTimer = () => {
    if (timerRef.current != null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const stepBy = (delta: number) => {
    const next = clampQuantity(value + delta, min, max);
    onChange(next);
  };

  const startRepeat = (delta: number) => {
    clearTimer();
    stepBy(delta);
    timerRef.current = setInterval(() => {
      const next = clampQuantity(valueRef.current + delta, min, max);
      if (next !== valueRef.current) {
        valueRef.current = next;
        onChange(next);
      }
    }, REPEAT_INTERVAL_MS);
  };

  // Returns the committed value so submit handlers can use it directly —
  // parent state updated via onChange is still the pre-commit value when a
  // submit callback fires in the same event. Idempotent: RN fires endEditing
  // after submit, and re-committing the same text is a no-op change-wise.
  const commitText = (): number => {
    editingRef.current = false;
    const parsed = parseQuantityInput(text, min, max, allowDecimal);
    const next = parsed ?? value;
    onChange(next);
    setText(formatQuantity(next));
    return next;
  };

  const atMin = value <= min;
  const atMax = max != null && value >= max;
  const rowHeight = size === 'sm' ? 36 : 44;

  const row = (
    <View style={[s.row, { height: rowHeight }]}>
      <Pressable
        onPress={() => stepBy(-step)}
        onLongPress={() => startRepeat(-step)}
        onPressOut={clearTimer}
        disabled={atMin}
        style={[s.btn, { height: rowHeight, width: rowHeight }, atMin && s.btnDisabled]}
      >
        <Text style={[s.btnText, atMin && s.btnTextDisabled]}>−</Text>
      </Pressable>
      <View style={[s.inputWrap, { height: rowHeight }]}>
        <TextInput
          style={s.input}
          value={text}
          onChangeText={(t) => {
            editingRef.current = true;
            setText(t);
          }}
          onFocus={() => {
            editingRef.current = true;
          }}
          onBlur={commitText}
          onEndEditing={commitText}
          onSubmitEditing={() => {
            const next = commitText();
            onSubmitEditing?.(next);
          }}
          returnKeyType={returnKeyType}
          keyboardType={allowDecimal ? 'decimal-pad' : 'number-pad'}
          textAlign="center"
        />
        {!!unit && <Text style={s.unit}>{unit}</Text>}
      </View>
      <Pressable
        onPress={() => stepBy(step)}
        onLongPress={() => startRepeat(step)}
        onPressOut={clearTimer}
        disabled={atMax}
        style={[s.btn, { height: rowHeight, width: rowHeight }, atMax && s.btnDisabled]}
      >
        <Text style={[s.btnText, atMax && s.btnTextDisabled]}>+</Text>
      </Pressable>
    </View>
  );

  if (label == null) return row;
  return <Field label={label}>{row}</Field>;
}

const makeStyles = (t: Theme) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  btn: {
    borderRadius: t.radii.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    backgroundColor: t.colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnDisabled: { borderColor: t.colors.borderDetail },
  btnText: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary },
  btnTextDisabled: { color: t.colors.textDisabled },
  inputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: t.colors.surface,
    borderRadius: t.radii.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    paddingHorizontal: t.spacing.sm,
  },
  input: {
    flex: 1,
    fontSize: t.typography.fontSizes.body,
    color: t.colors.textPrimary,
    padding: 0,
    textAlign: 'center',
  },
  unit: { fontSize: t.typography.fontSizes.body2, color: t.colors.textMuted, marginLeft: t.spacing.xs },
});
