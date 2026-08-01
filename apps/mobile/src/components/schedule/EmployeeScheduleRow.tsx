import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { StatusPill } from '../ui/StatusPill';
import type { ScheduleAssignmentView } from '../../db/queries/schedule';
import { SlotCell } from './SlotCell';
import { SLOT_ROW_LAYOUT, DAY_START_MIN, chipSpan } from './dayMath';

interface EmployeeLite { id: string; name: string }

interface Props {
  employee: EmployeeLite;
  /** This employee's ACTIVE assignments for the selected day only. */
  assignments: ScheduleAssignmentView[];
  /** Read-only for everyone; write affordances (empty-cell tap) only render when true. */
  canEdit: boolean;
  onCellPress: (employeeId: string, employeeName: string, startMinute: number, endMinute: number) => void;
  onChipPress: (assignment: ScheduleAssignmentView) => void;
}

// Fixed-width employee name OUTSIDE this row's own horizontal ScrollView (the
// name never scrolls away) + a track of hour cells with assignment chips
// absolutely positioned on top, spanning their [start_minute, end_minute)
// range via `chipSpan`. Assignments partly/fully outside the 8-17 viewport
// render clamped to the window edge with a small ◂/▸ off-window marker — the
// schema is minute-general, the 8-17 window is only a viewport (per the UI
// design's timeline-grid section).
export function EmployeeScheduleRow({ employee, assignments, canEdit, onCellPress, onChipPress }: Props) {
  const s = useThemedStyles(makeStyles);
  const { colWidth, hourCount, rowHeight, chipHeight, nameColWidth } = SLOT_ROW_LAYOUT;
  const trackWidth = colWidth * hourCount;

  function hourCovered(hourIndex: number): boolean {
    const hStart = DAY_START_MIN + hourIndex * 60;
    const hEnd = hStart + 60;
    return assignments.some(a => a.start_minute < hEnd && a.end_minute > hStart);
  }

  return (
    <View style={[s.row, { height: rowHeight }]}>
      <View style={[s.nameCol, { width: nameColWidth, height: rowHeight }]}>
        <Text style={s.nameText} numberOfLines={1}>{employee.name}</Text>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.scroll}>
        <View style={[s.track, { width: trackWidth, height: rowHeight }]}>
          {Array.from({ length: hourCount }, (_, i) => {
            const hStart = DAY_START_MIN + i * 60;
            const covered = hourCovered(i);
            return (
              <SlotCell
                key={i}
                width={colWidth}
                state={covered ? 'covered' : canEdit ? 'editable' : 'inert'}
                onPress={canEdit ? () => onCellPress(employee.id, employee.name, hStart, hStart + 60) : undefined}
              />
            );
          })}
          {assignments.map(a => {
            const span = chipSpan(a.start_minute, a.end_minute, colWidth);
            const isJob = a.assignment_kind === 'job';
            const label = isJob
              ? (a.job_name ?? 'Job')
              : `PM · ${(a.manager_name ?? 'Manager').split(' ')[0]}`;
            return (
              <TouchableOpacity
                key={a.id}
                style={[
                  s.chipWrap,
                  {
                    left: span.left,
                    width: Math.max(span.width, 4),
                    height: chipHeight,
                    top: (rowHeight - chipHeight) / 2,
                  },
                ]}
                onPress={() => onChipPress(a)}
                activeOpacity={0.75}
              >
                {span.clampedLeft && <Text style={s.offMarker}>◂</Text>}
                <StatusPill label={label} tone={isJob ? 'primary' : 'accent'} style={s.chipPill} />
                {span.clampedRight && <Text style={s.offMarker}>▸</Text>}
              </TouchableOpacity>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  row: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: t.colors.borderDetail },
  nameCol: { justifyContent: 'center', paddingHorizontal: t.spacing.sm, backgroundColor: t.colors.surface },
  nameText: { fontSize: t.typography.fontSizes.body2, color: t.colors.textPrimary, fontWeight: '600' },
  scroll: { flexGrow: 0 },
  track: { flexDirection: 'row', position: 'relative' },
  chipWrap: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  chipPill: { maxWidth: '100%' },
  offMarker: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted },
});
