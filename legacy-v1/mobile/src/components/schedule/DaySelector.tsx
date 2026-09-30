import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { ModalSheet } from '../ui/ModalSheet';
import { DateField } from '../ui/DateField';
import { CalendarGrid } from '../ui/CalendarGrid';
import { addDaysIso, formatDayLabel, localTodayIso } from './dayMath';

interface Props {
  day: string; // 'YYYY-MM-DD'
  onChange: (day: string) => void;
}

// ‹ [Tue, Aug 4] 📅 › — addDaysIso steps one day at a time; tapping the date
// label opens the jump sheet: an inline CalendarGrid (the kit's own — no
// nested Modal, unlike DateField's calendar mode which mounts its OWN
// ModalSheet) with a Today shortcut and a manual YYYY-MM-DD entry field
// (DateField calendar={false} quickPicks={false}) underneath.
export function DaySelector({ day, onChange }: Props) {
  const s = useThemedStyles(makeStyles);
  const [pickerOpen, setPickerOpen] = useState(false);

  function jumpTo(iso: string) {
    onChange(iso);
    setPickerOpen(false);
  }

  return (
    <View style={s.row}>
      <TouchableOpacity style={s.stepBtn} onPress={() => onChange(addDaysIso(day, -1))} hitSlop={8}>
        <Text style={s.stepBtnText}>‹</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.labelBtn} onPress={() => setPickerOpen(true)}>
        <Text style={s.label}>{formatDayLabel(day)}</Text>
        <Text style={s.calendarGlyph}>📅</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.stepBtn} onPress={() => onChange(addDaysIso(day, 1))} hitSlop={8}>
        <Text style={s.stepBtnText}>›</Text>
      </TouchableOpacity>
      <ModalSheet visible={pickerOpen} onClose={() => setPickerOpen(false)} scroll>
        <View style={s.sheetHeaderRow}>
          <Text style={s.sheetTitle}>Jump to date</Text>
          <TouchableOpacity style={s.todayChip} onPress={() => jumpTo(localTodayIso())}>
            <Text style={s.todayChipText}>Today</Text>
          </TouchableOpacity>
        </View>
        <CalendarGrid selected={day} onSelectDay={jumpTo} initialMonth={day} />
        <DateField
          label="Or type a date"
          value={day}
          onChange={iso => {
            if (!iso) return; // the board always needs a day — ignore empty
            jumpTo(iso);
          }}
          calendar={false}
          quickPicks={false}
        />
      </ModalSheet>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.spacing.md, paddingVertical: t.spacing.md },
  stepBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  stepBtnText: { fontSize: t.typography.fontSizes.lg, color: t.colors.textPrimary, fontWeight: '700' },
  labelBtn: {
    flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm,
    paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.sm,
    borderRadius: t.radii.md, backgroundColor: t.colors.surfaceAlt,
  },
  label: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.textPrimary },
  calendarGlyph: { fontSize: t.typography.fontSizes.body },
  sheetHeaderRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: t.spacing.md,
  },
  sheetTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary },
  todayChip: {
    backgroundColor: t.colors.primaryBg, borderRadius: t.radii.pill,
    paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.xs,
  },
  todayChipText: { fontSize: t.typography.fontSizes.body2, color: t.colors.primaryText, fontWeight: '600' },
});
