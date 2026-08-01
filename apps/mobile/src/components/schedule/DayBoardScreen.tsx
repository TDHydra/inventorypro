import { useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, type NativeSyntheticEvent, type NativeScrollEvent } from 'react-native';
import { Stack } from 'expo-router';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { useTableVersion } from '../../hooks/useDataVersion';
import { EmptyState } from '../ui/EmptyState';
import { DaySelector } from './DaySelector';
import { EmployeeScheduleRow } from './EmployeeScheduleRow';
import { AssignmentPickerSheet } from './AssignmentPickerSheet';
import { JobDetailPopup } from './JobDetailPopup';
import { PmContactPopup } from './PmContactPopup';
import { QuickCreateSheet } from '../quickadd/QuickCreateSheet';
import {
  getScheduleBoardForDay,
  getScheduleableEmployees,
  assignJobSlot,
  type ScheduleAssignmentView,
} from '../../db/queries/schedule';
import {
  localTodayIso,
  SLOT_ROW_LAYOUT,
  DAY_START_MIN,
  DAY_END_MIN,
  EXPANDED_START_MIN,
  EXPANDED_END_MIN,
} from './dayMath';

interface PendingRange { employeeId: string; employeeName: string; startMinute: number; endMinute: number }

type PopupState =
  | { kind: 'job'; jobId: string; assignmentId: string }
  | { kind: 'manager'; managerId: string; assignmentId: string }
  | null;

// #184: the schedule board's screen body (the route file itself stays thin —
// see app/(app)/(schedule)/index.tsx). Visible read-only to EVERYONE; write
// affordances (empty-cell tap, "Clear this slot") only render for
// manage_schedule editors — `canEdit` threads down, this screen never
// hard-gates the route itself (the dashboard tile is what's permission-hidden).
export function DayBoardScreen() {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const canEdit = usePermission('manage_schedule');
  const [day, setDay] = useState(() => localTodayIso());
  const [expanded, setExpanded] = useState(false);

  // At most one of these is ever visible at a time — AssignmentPickerSheet's
  // "Create a Job" row always calls onClose() (unmounting it, since it's only
  // rendered while `picker` is set) in the SAME event handler that opens
  // QuickCreateSheet, so the two Modals are never simultaneously visible
  // (the nested-Modal trap this feature's design calls out by name).
  const [picker, setPicker] = useState<PendingRange | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingRange | null>(null);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [popup, setPopup] = useState<PopupState>(null);

  // Frozen-pane grid (live review 2026-08-01): ONE horizontal ScrollView owns
  // every row's track so all rows scroll in lockstep; the hour header is a
  // separate scroll-locked ScrollView driven from the body's onScroll (it
  // can't live inside the body scroller — it must stay pinned while the rows
  // scroll VERTICALLY underneath it).
  const headerScrollRef = useRef<ScrollView>(null);
  const syncHeader = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    headerScrollRef.current?.scrollTo({ x: e.nativeEvent.contentOffset.x, animated: false });
  };

  // OnCallCalendar idiom: subscribe to the tables this screen reads so a sync
  // pull OR a local write (assign/clear) re-renders without a bespoke reload key.
  const version = useTableVersion(['schedule_assignments', 'users', 'jobs']);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const employees = useMemo(() => getScheduleableEmployees(), [version]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const assignments = useMemo(() => getScheduleBoardForDay(day), [day, version]);

  const assignmentsByEmployee = useMemo(() => {
    const map = new Map<string, ScheduleAssignmentView[]>();
    for (const a of assignments) {
      const list = map.get(a.employee_id);
      if (list) list.push(a); else map.set(a.employee_id, [a]);
    }
    return map;
  }, [assignments]);

  function handleCellPress(employeeId: string, employeeName: string, startMinute: number, endMinute: number) {
    setPicker({ employeeId, employeeName, startMinute, endMinute });
  }

  function handleChipPress(a: ScheduleAssignmentView) {
    if (a.assignment_kind === 'job' && a.job_id) {
      setPopup({ kind: 'job', jobId: a.job_id, assignmentId: a.id });
    } else if (a.assignment_kind === 'manager' && a.manager_id) {
      setPopup({ kind: 'manager', managerId: a.manager_id, assignmentId: a.id });
    }
  }

  function handleCreateJob(startMinute: number, endMinute: number) {
    if (!picker) return;
    setPendingCreate({ ...picker, startMinute, endMinute });
    setQuickCreateOpen(true);
  }

  const { nameColWidth, colWidth, rowHeight } = SLOT_ROW_LAYOUT;
  const windowStartMin = expanded ? EXPANDED_START_MIN : DAY_START_MIN;
  const windowEndMin = expanded ? EXPANDED_END_MIN : DAY_END_MIN;
  const hourCount = (windowEndMin - windowStartMin) / 60;
  const trackWidth = colWidth * hourCount;

  // Expand toggle (live review 2026-08-01): schedule managers always get it;
  // viewers only when something on this day actually spills outside the 8–5
  // window (otherwise the expanded board is just empty columns).
  const hasOutOfWindow = assignments.some(
    a => a.start_minute < DAY_START_MIN || a.end_minute > DAY_END_MIN,
  );
  const showExpandToggle = canEdit || hasOutOfWindow;

  function renderHourHeader() {
    return (
      <View style={[s.headerRow, { height: rowHeight }]}>
        <View style={[s.nameCol, { width: nameColWidth }]} />
        <ScrollView ref={headerScrollRef} horizontal scrollEnabled={false} showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', width: trackWidth }}>
            {Array.from({ length: hourCount }, (_, i) => {
              const hStart = windowStartMin + i * 60;
              const h24 = Math.floor(hStart / 60);
              const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
              return (
                <View key={i} style={[s.headerCell, { width: colWidth }]}>
                  <Text style={s.headerCellText}>{h12}{h24 < 12 ? 'a' : 'p'}</Text>
                </View>
              );
            })}
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={s.flex}>
      <Stack.Screen options={{ title: 'Schedule', headerShown: true }} />
      <DaySelector day={day} onChange={setDay} />
      {showExpandToggle && (
        <View style={s.expandRow}>
          <TouchableOpacity style={s.expandChip} onPress={() => setExpanded(v => !v)} activeOpacity={0.7}>
            <Text style={s.expandChipText}>
              {expanded ? '⇤ Standard hours (8a–5p)' : '⇥ Expand hours (5a–9p)'}
            </Text>
          </TouchableOpacity>
        </View>
      )}
      {employees.length === 0 ? (
        <EmptyState icon="🗓" title="No field crew to schedule" subtitle="Active crew members will appear here." />
      ) : (
        <>
          {renderHourHeader()}
          <ScrollView style={s.flex}>
            <View style={s.gridRow}>
              <View style={[s.nameCol, { width: nameColWidth }]}>
                {employees.map(e => (
                  <View key={e.id} style={[s.nameCell, { height: rowHeight }]}>
                    <Text style={s.nameText} numberOfLines={1}>{e.name}</Text>
                  </View>
                ))}
              </View>
              <ScrollView horizontal onScroll={syncHeader} scrollEventThrottle={16} bounces={false}>
                <View style={{ width: trackWidth }}>
                  {employees.map(e => (
                    <EmployeeScheduleRow
                      key={e.id}
                      employee={e}
                      assignments={assignmentsByEmployee.get(e.id) ?? []}
                      canEdit={canEdit}
                      windowStartMin={windowStartMin}
                      windowEndMin={windowEndMin}
                      onCellPress={handleCellPress}
                      onChipPress={handleChipPress}
                    />
                  ))}
                </View>
              </ScrollView>
            </View>
          </ScrollView>
        </>
      )}
      {picker && (
        <AssignmentPickerSheet
          visible
          onClose={() => setPicker(null)}
          employeeId={picker.employeeId}
          employeeName={picker.employeeName}
          day={day}
          initialStartMinute={picker.startMinute}
          initialEndMinute={picker.endMinute}
          onCreateJob={handleCreateJob}
        />
      )}
      <QuickCreateSheet
        visible={quickCreateOpen}
        kind="job"
        onClose={() => { setQuickCreateOpen(false); setPendingCreate(null); }}
        onCreated={created => {
          if (pendingCreate) {
            assignJobSlot(
              {
                employeeId: pendingCreate.employeeId, day,
                startMinute: pendingCreate.startMinute, endMinute: pendingCreate.endMinute,
                jobId: created.id,
              },
              user?.id ?? null,
            );
          }
          setQuickCreateOpen(false);
          setPendingCreate(null);
        }}
      />
      {popup?.kind === 'job' && (
        <JobDetailPopup
          visible
          onClose={() => setPopup(null)}
          jobId={popup.jobId}
          assignmentId={popup.assignmentId}
        />
      )}
      {popup?.kind === 'manager' && (
        <PmContactPopup
          visible
          onClose={() => setPopup(null)}
          managerId={popup.managerId}
          assignmentId={popup.assignmentId}
        />
      )}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  flex: { flex: 1, backgroundColor: t.colors.background },
  headerRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: t.colors.border },
  // Hour labels sit LEFT-aligned over the gridline they name (each cell's
  // left edge is its hour), not centered mid-cell — centering is what made
  // "which hour is this cell?" ambiguous in the live review.
  headerCell: { justifyContent: 'center', borderLeftWidth: 1, borderLeftColor: t.colors.border, paddingLeft: t.spacing.xs },
  headerCellText: { fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary, fontWeight: '600' },
  expandRow: { flexDirection: 'row', paddingHorizontal: t.spacing.md, paddingBottom: t.spacing.xs },
  expandChip: {
    borderWidth: 1,
    borderColor: t.colors.border,
    borderRadius: t.radii.pill,
    paddingVertical: t.spacing.xs,
    paddingHorizontal: t.spacing.sm,
    backgroundColor: t.colors.surface,
  },
  expandChipText: { fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary, fontWeight: '600' },
  gridRow: { flexDirection: 'row' },
  nameCol: { backgroundColor: t.colors.surface, borderRightWidth: 1, borderRightColor: t.colors.border },
  nameCell: { justifyContent: 'center', paddingHorizontal: t.spacing.sm, borderBottomWidth: 1, borderBottomColor: t.colors.borderDetail },
  nameText: { fontSize: t.typography.fontSizes.body2, color: t.colors.textPrimary, fontWeight: '600' },
});
