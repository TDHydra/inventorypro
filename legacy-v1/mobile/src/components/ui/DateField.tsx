import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { Field } from './Field';
import { AppInput } from './AppInput';
import { ModalSheet } from './ModalSheet';
import { CalendarGrid } from './CalendarGrid';
import { maskDateInput, validateDateValue, toIsoDateString } from './dateFieldLogic';

// A date field with zero native dependencies (no
// `@react-native-community/datetimepicker` — see README.md hard constraints):
// masked `YYYY-MM-DD` text entry that auto-inserts dashes as you type, plus
// Today / Yesterday / Clear quick-pick chips, plus a calendar button that
// opens a visual CalendarGrid picker in a ModalSheet (`calendar={false}` to
// keep the field text-only). Every prop addition is optional — the pre-#145
// call sites compile and behave unchanged (they just gain the calendar
// affordance).
//
// Usage:
//   <DateField label="Purchase date" value={purchaseDate} onChange={setPurchaseDate} />
//   <DateField
//     label="Warranty expiry" value={expiry} onChange={setExpiry}
//     min={today} required hint="Must be after purchase"
//   />
//   <DateField label="Note date" value={noteDate} onChange={setNoteDate} quickPicks={false} />
//   <DateField label="Legacy date" value={d} onChange={setD} calendar={false} />

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
  calendar?: boolean; // default true: calendar button opening a CalendarGrid sheet
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
  calendar = true,
}: Props) {
  const s = useThemedStyles(makeStyles);
  const [draft, setDraft] = useState(value);
  const [localError, setLocalError] = useState<string | undefined>(undefined);
  const [calendarOpen, setCalendarOpen] = useState(false);
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

  function pickFromCalendar(iso: string) {
    // CalendarGrid already disables out-of-bounds days; re-validate anyway so
    // a bad pick can never silently commit (same gate as typed entry).
    if (validateDateValue(iso, { min, max }).ok) {
      pick(iso);
      setCalendarOpen(false);
    }
  }

  const today = toIsoDateString(new Date());
  const yesterday = toIsoDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

  return (
    <Field label={label} required={required} hint={hint} error={externalError ?? localError}>
      <View style={s.inputRow}>
        <AppInput
          style={s.input}
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
        {calendar && (
          <Pressable
            style={s.calendarBtn}
            onPress={() => setCalendarOpen(true)}
            accessibilityLabel={`Open calendar for ${label}`}
          >
            <Text style={s.calendarGlyph}>📅</Text>
          </Pressable>
        )}
      </View>
      {calendar && (
        <ModalSheet visible={calendarOpen} onClose={() => setCalendarOpen(false)} scroll>
          <Text style={s.sheetHeader}>{label}</Text>
          <CalendarGrid
            selected={value || null}
            onSelectDay={pickFromCalendar}
            min={min}
            max={max}
            initialMonth={value || undefined}
          />
        </ModalSheet>
      )}
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

const makeStyles = (t: Theme) => StyleSheet.create({
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  input: { flex: 1 },
  // 44pt square — the kit's standard trigger height, sized for gloved use.
  calendarBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
    backgroundColor: t.colors.surface, borderRadius: t.radii.md,
    borderWidth: 1, borderColor: t.colors.border,
  },
  calendarGlyph: { fontSize: t.typography.fontSizes.md },
  sheetHeader: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.md },
  chipRow: { flexDirection: 'row', gap: t.spacing.sm },
  chip: {
    backgroundColor: t.colors.primaryBg,
    borderRadius: t.radii.xl,
    paddingHorizontal: t.spacing.base,
    paddingVertical: t.spacing.sm,
  },
  chipText: { fontSize: t.typography.fontSizes.body2, color: t.colors.primaryText, fontWeight: '600' },
});
