import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

export type SlotCellState =
  | 'covered'  // part of a chip span rendered on top — plain background, no dash
  | 'editable' // empty hour, editor can tap to open the assignment picker
  | 'inert';   // empty hour, read-only viewer — muted dash (OnCallCalendar s.unassigned treatment)

interface Props {
  state: SlotCellState;
  width: number;
  onPress?: () => void;
}

// One hour cell of the timeline grid's background track (EmployeeScheduleRow
// renders `SLOT_ROW_LAYOUT.hourCount` of these per row, then layers the
// spanning assignment chips on top via absolute positioning).
export function SlotCell({ state, width, onPress }: Props) {
  const s = useThemedStyles(makeStyles);

  if (state === 'editable' && onPress) {
    return <TouchableOpacity style={[s.cell, s.editable, { width }]} onPress={onPress} activeOpacity={0.6} />;
  }
  if (state === 'inert') {
    return (
      <View style={[s.cell, { width }]}>
        <Text style={s.dash}>—</Text>
      </View>
    );
  }
  return <View style={[s.cell, { width }]} />;
}

const makeStyles = (t: Theme) => StyleSheet.create({
  cell: {
    height: '100%',
    borderRightWidth: 1,
    borderRightColor: t.colors.borderDetail,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editable: { backgroundColor: t.colors.surfaceAlt },
  dash: { fontSize: t.typography.fontSizes.body, color: t.colors.textMuted },
});
