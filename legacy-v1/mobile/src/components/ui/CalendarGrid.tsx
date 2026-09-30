import { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import {
  monthGrid, monthLabel, monthFromIso, prevMonth, nextMonth,
  weekdayLabels, inRange, isRangeStart, isRangeEnd, todayIso,
  type WeekStartsOn,
} from './calendarMath';

// Presentational month-grid calendar with zero native dependencies (no
// `@react-native-community/datetimepicker` — see the kit's hard constraints):
// RN-core View/Text/Pressable only, so it's web-safe with no .web.tsx fork.
// Pure math lives in calendarMath.ts; this file is just layout + theming.
//
// Two selection modes, driven by which props are passed:
//   single date:  `selected` (highlight one day)
//   range:        `rangeStart` / `rangeEnd` (endpoints strong, span tinted)
// Either way every tap just calls `onSelectDay(iso)` — the OWNER decides what
// a tap means (set the value, extend a range via nextRangeSelection, …).
//
// Usage:
//   <CalendarGrid selected={date} onSelectDay={setDate} min={todayIso()} />
//   <CalendarGrid rangeStart={start} rangeEnd={end} onSelectDay={tap} />
//
// Day cells are 44pt tall (the kit's standard trigger height) for gloved
// field use; days outside [min, max] render disabled and don't fire.

interface Props {
  selected?: string | null;    // single-date mode: ISO 'YYYY-MM-DD'
  rangeStart?: string | null;  // range mode endpoints
  rangeEnd?: string | null;
  onSelectDay: (iso: string) => void;
  min?: string;                // ISO bound, inclusive
  max?: string;                // ISO bound, inclusive
  initialMonth?: string;       // any ISO date inside the month to open on
  weekStartsOn?: WeekStartsOn; // default 1 (Monday), matching on-call weeks
}

export function CalendarGrid({
  selected,
  rangeStart,
  rangeEnd,
  onSelectDay,
  min,
  max,
  initialMonth,
  weekStartsOn = 1,
}: Props) {
  const s = useThemedStyles(makeStyles);
  const [{ year, month }, setMonth] = useState(() =>
    monthFromIso(initialMonth || selected || rangeStart || todayIso()));

  const weeks = monthGrid(year, month, weekStartsOn);
  const today = todayIso();

  return (
    <View>
      <View style={s.header}>
        <Pressable style={s.navBtn} hitSlop={8} onPress={() => setMonth(prevMonth(year, month))}>
          <Text style={s.navGlyph}>‹</Text>
        </Pressable>
        <Text style={s.monthLabel}>{monthLabel(year, month)}</Text>
        <Pressable style={s.navBtn} hitSlop={8} onPress={() => setMonth(nextMonth(year, month))}>
          <Text style={s.navGlyph}>›</Text>
        </Pressable>
      </View>

      <View style={s.weekRow}>
        {weekdayLabels(weekStartsOn).map(d => (
          <Text key={d} style={s.weekday}>{d}</Text>
        ))}
      </View>

      {weeks.map(week => (
        <View key={week[0].iso} style={s.weekRow}>
          {week.map(cell => {
            const disabled = (!!min && cell.iso < min) || (!!max && cell.iso > max);
            const endpoint =
              cell.iso === selected ||
              isRangeStart(cell.iso, rangeStart ?? null) ||
              isRangeEnd(cell.iso, rangeEnd ?? null);
            const spanned = !endpoint && inRange(cell.iso, rangeStart ?? null, rangeEnd ?? null);
            return (
              <Pressable
                key={cell.iso}
                style={[s.day, spanned && s.daySpanned, endpoint && s.dayEndpoint]}
                disabled={disabled}
                onPress={() => onSelectDay(cell.iso)}
              >
                <Text
                  style={[
                    s.dayText,
                    !cell.inMonth && s.dayTextOutside,
                    cell.iso === today && s.dayTextToday,
                    spanned && s.dayTextSpanned,
                    endpoint && s.dayTextEndpoint,
                    disabled && s.dayTextDisabled,
                  ]}
                >
                  {cell.day}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: t.spacing.sm,
  },
  // 44pt square nav targets — same minimum as the kit's field triggers.
  navBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  navGlyph: { fontSize: t.typography.fontSizes.xl, color: t.colors.primary, fontWeight: '600' },
  monthLabel: { fontSize: t.typography.fontSizes.md, fontWeight: '700', color: t.colors.textPrimary },
  weekRow: { flexDirection: 'row' },
  weekday: {
    flex: 1, textAlign: 'center',
    fontSize: t.typography.fontSizes.caption, fontWeight: '600', color: t.colors.textMuted,
    paddingVertical: t.spacing.xs,
  },
  day: {
    flex: 1, height: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: t.radii.md, marginVertical: 1,
  },
  daySpanned: { backgroundColor: t.colors.primaryBg, borderRadius: 0 },
  dayEndpoint: { backgroundColor: t.colors.primary },
  dayText: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary },
  dayTextOutside: { color: t.colors.textMuted },
  dayTextToday: { fontWeight: '700', color: t.colors.primary },
  dayTextSpanned: { color: t.colors.primaryText },
  dayTextEndpoint: { color: t.colors.onPrimary, fontWeight: '700' },
  dayTextDisabled: { color: t.colors.textDisabled },
});
