import { useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { useTableVersion } from '../../hooks/useDataVersion';
import { ListScreenShell } from '../ui/ListScreenShell';
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
import { localTodayIso, SLOT_ROW_LAYOUT, DAY_START_MIN } from './dayMath';

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

  // At most one of these is ever visible at a time — AssignmentPickerSheet's
  // "Create a Job" row always calls onClose() (unmounting it, since it's only
  // rendered while `picker` is set) in the SAME event handler that opens
  // QuickCreateSheet, so the two Modals are never simultaneously visible
  // (the nested-Modal trap this feature's design calls out by name).
  const [picker, setPicker] = useState<PendingRange | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingRange | null>(null);
  const [quickCreateOpen, setQuickCreateOpen] = useState(false);
  const [popup, setPopup] = useState<PopupState>(null);

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

  function renderHourHeader() {
    const { nameColWidth, colWidth, hourCount, rowHeight } = SLOT_ROW_LAYOUT;
    return (
      <View style={[s.headerRow, { height: rowHeight }]}>
        <View style={{ width: nameColWidth }} />
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', width: colWidth * hourCount }}>
            {Array.from({ length: hourCount }, (_, i) => {
              const hStart = DAY_START_MIN + i * 60;
              const h24 = Math.floor(hStart / 60);
              const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
              return (
                <View key={i} style={[s.headerCell, { width: colWidth }]}>
                  <Text style={s.headerCellText}>{h12}</Text>
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
      <ListScreenShell
        data={employees}
        aboveList={renderHourHeader()}
        renderItem={({ item }) => (
          <EmployeeScheduleRow
            employee={item}
            assignments={assignmentsByEmployee.get(item.id) ?? []}
            canEdit={canEdit}
            onCellPress={handleCellPress}
            onChipPress={handleChipPress}
          />
        )}
        emptyState={
          <EmptyState icon="🗓" title="No field crew to schedule" subtitle="Active crew members will appear here." />
        }
        onReload={() => {}}
      />
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
  headerCell: { alignItems: 'center', justifyContent: 'center' },
  headerCellText: { fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary, fontWeight: '600' },
});
