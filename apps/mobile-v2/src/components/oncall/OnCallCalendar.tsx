import { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles, StatusPill } from '@invenpro/ui';
import { useTableVersion, runInTransaction } from '@invenpro/core';
import { useSession } from '../../hooks/useSession';
import { SearchablePicker, type PickerOption } from '../SearchablePicker';
import { appendLog } from '../../db/queries/log';
import { addDaysIso, boundaryWeekStartIso, enumerateWeeks, formatWeekRange, localTodayIso, localNowHour } from './weekMath';
import {
  assignWeek,
  ensureRotationFill,
  getAssignableCrews,
  getShifts,
  getWeekBoundary,
  type OnCallShift,
} from '../../repos/oncall';

interface Props {
  /** Whole weeks shown before the current one. */
  weeksBack?: number;
  /** Whole weeks shown after the current one. */
  weeksForward?: number;
  /** Editors (manage_teams) can tap a week to assign/clear its crew. */
  canEdit: boolean;
  /** Fires after a local assign/clear commits — hosts refresh their own reads. */
  onAssign?: (weekStartIso: string, subteamId: string | null) => void;
}

// Station C2: ported from apps/mobile/src/components/oncall/OnCallCalendar.tsx.
// Import mapping: '../ui/*' -> '@invenpro/ui', '../../hooks/useDataVersion'
// -> '@invenpro/core', '../../db/queries/oncall' -> '../../repos/oncall'.
// localTodayIso/localNowHour now imported straight from './weekMath' (their
// actual home) instead of via this file's old re-export shim — mobile-v2's
// dayMath.ts already re-exports the day-string helper straight from weekMath
// too, so there's no lingering "re-exported for historical reasons" indirection
// to carry forward here.
//
// Week-row agenda for the on-call schedule (#128) — no month grid. One row per
// week (past `weeksBack` → current → next `weeksForward`), each showing the
// date range and the assigned crew (or an em dash). Current week highlighted.
// Tap-to-assign for editors expands an inline crew picker under the row (NOT a
// nested ModalSheet — this component is designed to live inside one page,
// see app/(app)/oncall/index.tsx). Renders plain Views so the host screen
// owns scrolling.
//
// Behavior change (no-self-log convention): assignWeek() no longer logs
// 'on_call_assigned' itself — this component now builds that entry (skipping
// it entirely when assignWeek returns null, i.e. a true clear-of-nothing
// no-op), wrapped in the SAME runInTransaction the repo call already opens
// (reentrant -> one commit).
export function OnCallCalendar({ weeksBack = 2, weeksForward = 8, canEdit, onAssign }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  // app_config carries the boundary + rotation settings — without subscribing,
  // a synced settings change wouldn't re-render (the reactive-cache gotcha).
  // Local assigns/clears tick the bus too (post-commit bump), so no local counter.
  const version = useTableVersion(['on_call_shifts', 'subteams', 'app_config']);
  const [editingWeek, setEditingWeek] = useState<string | null>(null);

  const today = localTodayIso();
  const hour = localNowHour();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const boundary = useMemo(() => getWeekBoundary(), [version]);
  const currentWeek = boundaryWeekStartIso(today, hour, boundary);
  const weeks = useMemo(
    () => enumerateWeeks(addDaysIso(currentWeek, -7 * weeksBack), weeksBack + 1 + weeksForward, boundary.day),
    [currentWeek, weeksBack, weeksForward, boundary.day],
  );

  // Auto-fill upcoming weeks from the rotation on open — editors only
  // (non-editors would get server manage_teams conflicts on push). No
  // activity log for autofill (mechanical, not a user action — see
  // ensureRotationFill's own header comment).
  useEffect(() => {
    if (!canEdit) return;
    // A non-zero fill writes shifts, which bumps on_call_shifts on the bus.
    ensureRotationFill(today, hour, user?.id ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canEdit, today, version]);

  const shiftByWeek = useMemo(() => {
    const map = new Map<string, OnCallShift>();
    if (weeks.length === 0) return map;
    for (const shift of getShifts(weeks[0]!, weeks[weeks.length - 1]!)) {
      map.set(shift.week_start, shift);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weeks, version]);

  const crewOptions = useMemo<PickerOption[]>(
    () => getAssignableCrews().map(c => ({ id: c.id, label: c.name, sublabel: c.team_name ?? undefined })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  const commit = (week: string, subteamId: string | null) => {
    const userId = user?.id ?? null;
    runInTransaction(() => {
      const result = assignWeek(week, subteamId, userId);
      if (!result) return; // no-op clear (already unassigned) — nothing to log
      appendLog({
        user_id: userId, team_id: result.teamId, action: 'on_call_assigned', entity_type: 'team',
        entity_id: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
        job_id: null,
        note: result.crewName
          ? `${result.crewName} on-call for week of ${week}`
          : `On-call cleared for week of ${week}`,
        metadata: JSON.stringify({ shift_id: result.id, week_start: week, subteam_id: subteamId }),
        device_id: null,
      });
    });
    setEditingWeek(null);
    onAssign?.(week, subteamId);
  };

  return (
    <View>
      {weeks.map(week => {
        const shift = shiftByWeek.get(week);
        // Boundary-aware: on the boundary day before the flip hour, a
        // date-only window (isCurrentWeek) would highlight the wrong row.
        const current = week === currentWeek;
        const editing = editingWeek === week;
        return (
          <View key={week}>
            <TouchableOpacity
              style={[s.row, current && s.rowCurrent]}
              disabled={!canEdit}
              onPress={() => setEditingWeek(editing ? null : week)}
              activeOpacity={0.7}
            >
              <View style={s.rowLeft}>
                <Text style={[s.range, current && s.rangeCurrent]}>{formatWeekRange(week)}</Text>
                {current && <Text style={s.thisWeek}>This week</Text>}
              </View>
              {shift?.subteam_id ? (
                <StatusPill label={shift.subteam_name ?? 'Unknown crew'} tone={current ? 'primary' : 'neutral'} />
              ) : (
                <Text style={s.unassigned}>—</Text>
              )}
            </TouchableOpacity>
            {editing && (
              <View style={s.editor}>
                <Text style={s.editorLabel}>Assign crew for {formatWeekRange(week)}</Text>
                <SearchablePicker
                  placeholder="Search crews…"
                  options={crewOptions}
                  value={null}
                  onSelect={opt => commit(week, opt.id)}
                />
                <View style={s.editorActions}>
                  {!!shift?.subteam_id && (
                    <TouchableOpacity onPress={() => commit(week, null)}>
                      <Text style={s.clearText}>Clear assignment</Text>
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity onPress={() => setEditingWeek(null)}>
                    <Text style={s.cancelText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: t.spacing.md, paddingHorizontal: t.spacing.sm,
    borderBottomWidth: 1, borderBottomColor: t.colors.borderDetail,
  },
  rowCurrent: {
    backgroundColor: t.colors.primaryBg,
    borderRadius: t.radii.md,
    borderBottomColor: 'transparent',
  },
  rowLeft: { flexShrink: 1, paddingRight: t.spacing.sm },
  range: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary },
  rangeCurrent: { color: t.colors.primaryText, fontWeight: t.typography.weights.semibold },
  thisWeek: { fontSize: t.typography.fontSizes.caption, color: t.colors.primaryText, marginTop: 1 },
  unassigned: { fontSize: t.typography.fontSizes.body, color: t.colors.textMuted },
  editor: {
    backgroundColor: t.colors.surfaceAlt, borderRadius: t.radii.md,
    padding: t.spacing.base, marginVertical: t.spacing.sm,
  },
  editorLabel: {
    fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary,
    marginBottom: t.spacing.sm,
  },
  editorActions: {
    flexDirection: 'row', justifyContent: 'flex-end', gap: t.spacing.lg,
    marginTop: t.spacing.md,
  },
  clearText: { fontSize: t.typography.fontSizes.body2, color: t.colors.danger, fontWeight: '600' },
  cancelText: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, fontWeight: '600' },
});
