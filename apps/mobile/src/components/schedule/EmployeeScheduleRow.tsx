import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { StatusPill } from '../ui/StatusPill';
import type { ScheduleAssignmentView } from '../../db/queries/schedule';
import { SlotCell } from './SlotCell';
import { SLOT_ROW_LAYOUT, chipSpan } from './dayMath';

interface EmployeeLite { id: string; name: string }

interface Props {
  employee: EmployeeLite;
  /** This employee's ACTIVE assignments for the selected day only. */
  assignments: ScheduleAssignmentView[];
  /** Read-only for everyone; write affordances (empty-cell tap) only render when true. */
  canEdit: boolean;
  /** Visible viewport (minutes since midnight) — DAY_* or EXPANDED_* window. */
  windowStartMin: number;
  windowEndMin: number;
  onCellPress: (employeeId: string, employeeName: string, startMinute: number, endMinute: number) => void;
  onChipPress: (assignment: ScheduleAssignmentView) => void;
}

// ONE employee's hour-cell track: SLOT_ROW_LAYOUT.hourCount SlotCells with the
// spanning assignment chips absolutely positioned on top. This component owns
// NO ScrollView and no name column — DayBoardScreen renders the pinned name
// column separately and hosts every row inside a SINGLE shared horizontal
// ScrollView, so all rows and the hour header scroll in unison (live review
// 2026-08-01: per-row scrollers desynced from the header and each other,
// making cell times unreadable). Assignments partly/fully outside the 8-17
// viewport render clamped to the window edge with a small ◂/▸ off-window
// marker — the schema is minute-general, the 8-17 window is only a viewport.
export function EmployeeScheduleRow({ employee, assignments, canEdit, windowStartMin, windowEndMin, onCellPress, onChipPress }: Props) {
  const s = useThemedStyles(makeStyles);
  const { colWidth, rowHeight, chipHeight } = SLOT_ROW_LAYOUT;
  const hourCount = (windowEndMin - windowStartMin) / 60;
  const trackWidth = colWidth * hourCount;

  function hourCovered(hourIndex: number): boolean {
    const hStart = windowStartMin + hourIndex * 60;
    const hEnd = hStart + 60;
    return assignments.some(a => a.start_minute < hEnd && a.end_minute > hStart);
  }

  return (
    <View style={[s.track, { width: trackWidth, height: rowHeight }]}>
      {Array.from({ length: hourCount }, (_, i) => {
        const hStart = windowStartMin + i * 60;
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
        const span = chipSpan(a.start_minute, a.end_minute, colWidth, windowStartMin, windowEndMin);
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
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  track: {
    flexDirection: 'row',
    position: 'relative',
    borderBottomWidth: 1,
    borderBottomColor: t.colors.borderDetail,
  },
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
