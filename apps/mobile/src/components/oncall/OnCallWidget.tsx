import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useTableVersion } from '../../hooks/useDataVersion';
import { usePermission } from '../../hooks/usePermission';
import { useSession } from '../../hooks/useSession';
import { ModalSheet } from '../ui/ModalSheet';
import { PrimaryButton } from '../ui/PrimaryButton';
import { OnCallCalendar, localNowHour, localTodayIso } from './OnCallCalendar';
import { CoverageSheet } from './CoverageSheet';
import { getCoverage, getCurrentShift, getWeekBoundary } from '../../db/queries/oncall';
import { addDaysIso, boundaryWeekStartIso, formatWeekRange } from './weekMath';
import { ROLE_TIER, type UserRole } from '../../constants/roles';

// Self-contained on-call dashboard block (#128): a themed button showing the
// live current-week assignment that OWNS its modal state — tapping it opens the
// week-row agenda (OnCallCalendar) in a ModalSheet, tap-to-assign for
// manage_teams holders. The dashboard just imports and mounts <OnCallWidget />;
// no props, no wiring (the first "block that owns a modal" widget).
export function OnCallWidget() {
  const s = useThemedStyles(makeStyles);
  const canEdit = usePermission('manage_teams');
  // PM-gated (spec): explicit Production Manager check + tier-3+ org authority.
  // PM is tier 2, so a plain `roleTier >= 2` would over-admit every tier-2
  // manager. Server enforces manage_teams; this is the UI shape of the PM rule.
  const { user } = useSession();
  const roleTier = user ? ROLE_TIER[user.role as UserRole] ?? 0 : 0;
  const canCoverage = canEdit && (user?.role === 'production_manager' || roleTier >= 3);
  const [open, setOpen] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  // Local assigns/coverage writes and sync pulls both tick the table-version
  // bus, so the current assignment and coverage list re-read live off it alone.
  const version = useTableVersion(['on_call_shifts', 'subteams', 'app_config', 'on_call_coverage']);

  const today = localTodayIso();
  const shift = useMemo(
    // Boundary-aware (Phase C): the local hour decides the week on the
    // boundary day itself (Thursday 07:59 still shows last week's crew).
    () => getCurrentShift(today, localNowHour()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [today, version],
  );
  const crewLabel = shift?.subteam_id ? (shift.subteam_name ?? 'Unknown crew') : null;

  // Upcoming coverage entries for the next 60 days (empty → section hidden).
  const coverage = useMemo(
    () => getCoverage(today, addDaysIso(today, 60)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [today, version],
  );

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
          Week of {formatWeekRange(boundaryWeekStartIso(today, localNowHour(), getWeekBoundary()))}
          {canEdit ? ' — tap a week to assign a crew' : ''}
        </Text>
        <OnCallCalendar canEdit={canEdit} />
        {coverage.length > 0 && (
          <View style={s.coverageSection}>
            <Text style={s.coverageTitle}>Upcoming coverage</Text>
            {coverage.map(c => (
              <View key={c.id} style={s.coverageRow}>
                <Text style={s.coverageText}>
                  {c.covering_user_name ?? 'Someone'} covers {c.user_off_name ?? 'someone'}{' '}
                  ({c.date_start} – {c.date_end})
                </Text>
                {c.note ? <Text style={s.coverageNote}>{c.note}</Text> : null}
              </View>
            ))}
          </View>
        )}
        {canCoverage && (
          <PrimaryButton
            label="Add coverage"
            onPress={() => setCoverageOpen(true)}
            style={s.coverageButton}
          />
        )}
      </ModalSheet>

      {/* Mounted OUTSIDE the ModalSheet (sibling): FormSheet stacks its own
          sheet — the AddServiceRecordSheet host pattern. */}
      <CoverageSheet
        visible={coverageOpen}
        onClose={() => setCoverageOpen(false)}
      />
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
  coverageSection: { marginTop: t.spacing.md },
  coverageTitle: {
    fontSize: t.typography.fontSizes.caption,
    color: t.colors.textMuted,
    fontFamily: t.typography.fontFamily.medium,
    letterSpacing: t.typography.letterSpacing,
    marginBottom: t.spacing.xs,
  },
  coverageRow: { paddingVertical: t.spacing.xs },
  coverageText: {
    fontSize: t.typography.fontSizes.base,
    color: t.colors.textPrimary,
  },
  coverageNote: {
    fontSize: t.typography.fontSizes.caption,
    color: t.colors.textMuted,
    marginTop: 1,
  },
  coverageButton: { marginTop: t.spacing.md },
});
