import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, radii, spacing, fontSizes } from '../../theme';
import { Field } from './Field';
import { AppInput } from './AppInput';
import { maskDateInput, validateDateValue, toIsoDateString } from './dateFieldLogic';

// A date field with zero native dependencies (no
// `@react-native-community/datetimepicker` — see README.md hard constraints):
// masked `YYYY-MM-DD` text entry that auto-inserts dashes as you type, plus
// Today / Yesterday / Clear quick-pick chips.
//
// Usage:
//   <DateField label="Purchase date" value={purchaseDate} onChange={setPurchaseDate} />
//   <DateField
//     label="Warranty expiry" value={expiry} onChange={setExpiry}
//     min={today} required hint="Must be after purchase"
//   />
//   <DateField label="Note date" value={noteDate} onChange={setNoteDate} quickPicks={false} />

interface Props {
  label: string;
  value: string; // ISO 'YYYY-MM-DD' or ''
  onChange: (iso: string) => void;
  required?: boolean;
  hint?: string;
  error?: string;
  min?: string; // ISO bound, inclusive
  max?: string; // ISO bound, inclusive
  quickPicks?: boolean; // default true: Today / Yesterday / Clear chips
}

export function DateField({
  label,
  value,
  onChange,
  required,
  hint,
  error: externalError,
  min,
  max,
  quickPicks = true,
}: Props) {
  const [draft, setDraft] = useState(value);
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const editingRef = useRef(false);

  // Keep the local draft in sync with external value changes (form reset,
  // parent-driven fill) while the user isn't mid-edit — same pattern as
  // QuantityStepper, avoids clobbering keystrokes on a controlled re-render.
  useEffect(() => {
    if (!editingRef.current) setDraft(value);
  }, [value]);

  function commit(masked: string) {
    if (masked === '') {
      setLocalError(undefined);
      onChange('');
      return;
    }
    if (masked.length < 10) {
      // Still typing a partial date — hold locally, don't validate/emit yet.
      setLocalError(undefined);
      return;
    }
    const result = validateDateValue(masked, { min, max });
    if (result.ok) {
      setLocalError(undefined);
      onChange(masked);
    } else {
      setLocalError(result.error);
    }
  }

  function handleChangeText(raw: string) {
    editingRef.current = true;
    const masked = maskDateInput(raw, draft);
    setDraft(masked);
    commit(masked);
  }

  function pick(iso: string) {
    editingRef.current = false;
    setDraft(iso);
    setLocalError(undefined);
    onChange(iso);
  }

  function clear() {
    pick('');
  }

  const today = toIsoDateString(new Date());
  const yesterday = toIsoDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

  return (
    <Field label={label} required={required} hint={hint} error={externalError ?? localError}>
      <AppInput
        value={draft}
        onChangeText={handleChangeText}
        onBlur={() => {
          editingRef.current = false;
          // A partial draft (e.g. "2026-07") never got committed via
          // handleChangeText (commit() only validates/emits at full length),
          // so without this the field silently shows uncommitted text with
          // no error. Surface the same inline error a completed-but-invalid
          // date gets (reusing localError) instead of auto-clearing the
          // user's typed text.
          if (draft !== '' && draft.length < 10) {
            setLocalError('Enter a valid date (YYYY-MM-DD).');
          }
        }}
        placeholder="YYYY-MM-DD"
        keyboardType="number-pad"
        maxLength={10}
      />
      {quickPicks && (
        <View style={s.chipRow}>
          <Pressable style={s.chip} onPress={() => pick(today)}>
            <Text style={s.chipText}>Today</Text>
          </Pressable>
          <Pressable style={s.chip} onPress={() => pick(yesterday)}>
            <Text style={s.chipText}>Yesterday</Text>
          </Pressable>
          <Pressable style={s.chip} onPress={clear}>
            <Text style={s.chipText}>Clear</Text>
          </Pressable>
        </View>
      )}
    </Field>
  );
}

const s = StyleSheet.create({
  chipRow: { flexDirection: 'row', gap: spacing.sm },
  chip: {
    backgroundColor: colors.primaryBg,
    borderRadius: radii.xl,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
  },
  chipText: { fontSize: fontSizes.body2, color: colors.primaryText, fontWeight: '600' },
});
