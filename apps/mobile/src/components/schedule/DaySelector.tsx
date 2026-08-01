import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { ModalSheet } from '../ui/ModalSheet';
import { DateField } from '../ui/DateField';
import { addDaysIso, formatDayLabel } from './dayMath';

interface Props {
  day: string; // 'YYYY-MM-DD'
  onChange: (day: string) => void;
}

// ‹ [Tue, Aug 4] 📅 › — addDaysIso steps one day at a time; tapping the date
// label opens a ModalSheet hosting a DateField for jumping straight to an
// arbitrary date. DateField renders with `calendar={false}` so its OWN
// internal calendar-grid ModalSheet never mounts — keeping exactly one Modal
// visible at a time (the nested-Modal trap this feature's design explicitly
// calls out, live elsewhere in (teams)/[id].tsx).
export function DaySelector({ day, onChange }: Props) {
  const s = useThemedStyles(makeStyles);
  const [pickerOpen, setPickerOpen] = useState(false);

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
        <DateField
          label="Jump to date"
          value={day}
          onChange={iso => {
            if (!iso) return; // the board always needs a day — ignore the Clear chip
            onChange(iso);
            setPickerOpen(false);
          }}
          calendar={false}
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
});
