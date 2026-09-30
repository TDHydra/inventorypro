import { useState } from 'react';
import { Pressable, Text, View, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { Field } from './Field';
import { ModalSheet } from './ModalSheet';
import { CalendarGrid } from './CalendarGrid';
import { nextRangeSelection } from './calendarMath';

// Labeled start → end date-range field: tap the field → bottom sheet with a
// CalendarGrid → two-tap selection (first tap = first day, second tap on/after
// it = last day and the sheet closes; tapping BEFORE the current first day
// restarts the range there — see calendarMath.nextRangeSelection). Same
// trigger/ModalSheet idiom as SelectField; zero native dependencies.
//
// The pending first-day tap is emitted immediately (`onChange(start, '')`), so
// the parent's draft state — and any dirty/discard-guard calc — always matches
// what the sheet shows. Closing the sheet mid-selection keeps that start.
//
// Usage:
//   <DateRangeField
//     label="Days off" required
//     start={dateStart} end={dateEnd}
//     onChange={(start, end) => { setDateStart(start); setDateEnd(end); }}
//     min={localTodayIso()}
//   />

interface Props {
  label: string;
  start: string;  // ISO 'YYYY-MM-DD' or ''
  end: string;    // ISO 'YYYY-MM-DD' or ''
  onChange: (start: string, end: string) => void;
  required?: boolean;
  hint?: string;
  error?: string;
  min?: string;   // ISO bound, inclusive
  max?: string;   // ISO bound, inclusive
  placeholder?: string; // default 'Select dates…'
}

export function DateRangeField({
  label, start, end, onChange,
  required, hint, error, min, max,
  placeholder = 'Select dates…',
}: Props) {
  const s = useThemedStyles(makeStyles);
  const [open, setOpen] = useState(false);

  function tapDay(iso: string) {
    const next = nextRangeSelection({ start: start || null, end: end || null }, iso);
    onChange(next.start ?? '', next.end ?? '');
    // Second tap completed the range — close so field entry stays two taps.
    if (next.end) setOpen(false);
  }

  function clear() {
    onChange('', '');
  }

  const summary = start ? `${start}  →  ${end || 'last day…'}` : null;

  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <Pressable style={s.trigger} onPress={() => setOpen(true)}>
        <Text style={summary ? s.value : s.placeholder} numberOfLines={1}>
          {summary ?? placeholder}
        </Text>
        <Text style={s.glyph}>▾</Text>
      </Pressable>

      <ModalSheet visible={open} onClose={() => setOpen(false)} scroll>
        <Text style={s.header}>{label}</Text>
        <Text style={s.stepHint}>
          {!start || end ? 'Tap the first day' : 'Tap the last day (earlier restarts)'}
        </Text>
        <CalendarGrid
          rangeStart={start || null}
          rangeEnd={end || null}
          onSelectDay={tapDay}
          min={min}
          max={max}
          initialMonth={start || undefined}
        />
        <View style={s.footer}>
          {!!start && (
            <Pressable style={s.chip} onPress={clear}>
              <Text style={s.chipText}>Clear</Text>
            </Pressable>
          )}
        </View>
      </ModalSheet>
    </Field>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  trigger: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base, height: 44,
  },
  value: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, flexShrink: 1 },
  placeholder: { fontSize: t.typography.fontSizes.body, color: t.colors.textMuted, flexShrink: 1 },
  glyph: { fontSize: t.typography.fontSizes.body, color: t.colors.textMuted, marginLeft: t.spacing.sm },
  header: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.xs },
  stepHint: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, marginBottom: t.spacing.md },
  footer: { flexDirection: 'row', marginTop: t.spacing.md, minHeight: 36 },
  chip: {
    backgroundColor: t.colors.primaryBg, borderRadius: t.radii.xl,
    paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.sm,
  },
  chipText: { fontSize: t.typography.fontSizes.body2, color: t.colors.primaryText, fontWeight: '600' },
});
