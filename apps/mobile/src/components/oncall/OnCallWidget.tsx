import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useTableVersion } from '../../hooks/useDataVersion';
import { usePermission } from '../../hooks/usePermission';
import { ModalSheet } from '../ui/ModalSheet';
import { OnCallCalendar, localTodayIso } from './OnCallCalendar';
import { getCurrentShift } from '../../db/queries/oncall';
import { formatWeekRange, weekStartIso } from './weekMath';

// Self-contained on-call dashboard block (#128): a themed button showing the
// live current-week assignment that OWNS its modal state — tapping it opens the
// week-row agenda (OnCallCalendar) in a ModalSheet, tap-to-assign for
// manage_teams holders. The dashboard just imports and mounts <OnCallWidget />;
// no props, no wiring (the first "block that owns a modal" widget).
export function OnCallWidget() {
  const s = useThemedStyles(makeStyles);
  const canEdit = usePermission('manage_teams');
  const [open, setOpen] = useState(false);
  const version = useTableVersion(['on_call_shifts', 'subteams']);
  // Local assigns (via the calendar's onAssign) don't bump the sync table
  // version, so track our own bump to re-read the current assignment live.
  const [localBump, setLocalBump] = useState(0);

  const today = localTodayIso();
  const shift = useMemo(
    // Boundary-aware (Phase C): the local hour decides the week on the
    // boundary day itself (Thursday 07:59 still shows last week's crew).
    () => getCurrentShift(today, new Date().getHours()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [today, version, localBump],
  );
  const crewLabel = shift?.subteam_id ? (shift.subteam_name ?? 'Unknown crew') : null;

  return (
    <>
      <TouchableOpacity style={s.block} onPress={() => setOpen(true)} activeOpacity={0.7}>
        <View style={s.blockLeft}>
          <Text style={s.caption}>On-call this week</Text>
          <Text style={crewLabel ? s.crew : s.crewUnassigned}>
            {crewLabel ? `On-call: ${crewLabel}` : 'On-call: unassigned'}
          </Text>
        </View>
        <Text style={s.chevron}>›</Text>
      </TouchableOpacity>

      <ModalSheet visible={open} onClose={() => setOpen(false)} scroll>
        <Text style={s.sheetTitle}>On-call schedule</Text>
        <Text style={s.sheetSub}>
          Week of {formatWeekRange(weekStartIso(today))}
          {canEdit ? ' — tap a week to assign a crew' : ''}
        </Text>
        <OnCallCalendar
          canEdit={canEdit}
          onAssign={() => setLocalBump(v => v + 1)}
        />
      </ModalSheet>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  block: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: t.colors.surface,
    borderRadius: t.radii.card,
    borderWidth: t.components.card.borderWidth,
    borderColor: t.colors.border,
    paddingVertical: t.spacing.base, paddingHorizontal: t.spacing.lg,
  },
  blockLeft: { flexShrink: 1 },
  caption: {
    fontSize: t.typography.fontSizes.caption,
    color: t.colors.textMuted,
    fontFamily: t.typography.fontFamily.medium,
    letterSpacing: t.typography.letterSpacing,
    marginBottom: 2,
  },
  crew: {
    fontSize: t.typography.fontSizes.base,
    color: t.colors.textPrimary,
    fontWeight: t.typography.weights.semibold,
    fontFamily: t.typography.fontFamily.medium,
  },
  crewUnassigned: {
    fontSize: t.typography.fontSizes.base,
    color: t.colors.textMuted,
  },
  chevron: { fontSize: 22, color: t.colors.textMuted, marginLeft: t.spacing.sm },
  sheetTitle: {
    fontSize: t.typography.fontSizes.lg,
    fontWeight: t.typography.weights.bold,
    fontFamily: t.typography.fontFamily.bold,
    color: t.colors.textPrimary,
  },
  sheetSub: {
    fontSize: t.typography.fontSizes.caption,
    color: t.colors.textSecondary,
    marginTop: 2,
    marginBottom: t.spacing.md,
  },
});
