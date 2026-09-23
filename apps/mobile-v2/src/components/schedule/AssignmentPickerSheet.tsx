import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles, ModalSheet, PrimaryButton, TimeWheelPicker, Alert } from '@invenpro/ui';
import { useDbQuery, runInTransaction } from '@invenpro/core';
import { generateUUID } from '../../utils/uuid';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { SearchablePicker, type PickerOption } from '../SearchablePicker';
import { isWriteBlocked } from '../../db/maintenance';
import { appendLog } from '../../db/queries/log';
import { getOpenJobs, upsertJob, type Job } from '../../repos/jobs';
import {
  assignJobSlot,
  assignManagerSlot,
  getAssignableManagers,
  ScheduleConflictError,
  type ScheduleAssignmentView,
} from '../../repos/schedule';
import { DAY_START_MIN, DAY_END_MIN, formatMinute, snapRange } from './dayMath';

// Station C2: ported from apps/mobile/src/components/schedule/
// AssignmentPickerSheet.tsx. Import mapping applied: '../ui/*' -> '@invenpro/ui',
// '../../db/queries/schedule' -> '../../repos/schedule', '../../db/queries/jobs'
// -> '../../repos/jobs', '../../db/tx'+'../../sync/outbox' -> '@invenpro/core'.
//
// Behavior change (no-self-log convention, docs/REBUILD-PORTING.md): the old
// app's trySlotAssign() relied on assignJobSlot/assignManagerSlot to log
// 'schedule_assigned' internally. The repo layer no longer does that (see
// schedule.ts's header comment), so this screen now builds the
// 'schedule_assigned' log entry itself for every successful assign — wrapped
// in the SAME runInTransaction the repo call already opens (reentrant, so
// this is one atomic commit, identical to the old app's guarantee). Likewise
// createJobInline's inline job-create keeps its own runInTransaction(upsertJob
// + appendLog 'job_created') exactly as before — that path never went through
// createRepository (jobs.ts's own upsertJob is a dual-write helper, unchanged).

type Step = 'menu' | 'job-search' | 'pm-list';

interface Props {
  visible: boolean;
  onClose: () => void;
  employeeId: string;
  employeeName: string;
  day: string;
  initialStartMinute: number;
  initialEndMinute: number;
  /**
   * "Create a Job" hands off to the full JobQuickAdd form (parent-owned
   * QuickCreateSheet — never two visible Modals at once, so this sheet
   * closes itself before the parent opens the other one). Called with the
   * CURRENT in-sheet range (the user may have adjusted it via the range
   * editor before choosing this row) so the parent's pending-range state
   * for the create handoff can't go stale.
   */
  onCreateJob: (startMinute: number, endMinute: number) => void;
}

// #184: ONE ModalSheet with internal step state — never nested Modals (the
// live (teams)/[id].tsx nested-Modal trap: two Modals visible at once breaks
// Android touch dispatch). "Create a Job" is the one path that leaves this
// sheet — it always closes THIS sheet first (onCreateJob is only ever called
// right before onClose()), so the sibling QuickCreateSheet the parent owns is
// never mounted-and-visible at the same time as this one.
export function AssignmentPickerSheet({
  visible, onClose, employeeId, employeeName, day, initialStartMinute, initialEndMinute, onCreateJob,
}: Props) {
  const s = useThemedStyles(makeStyles);
  const { user, realUser } = useSession();
  const canCreateJobs = usePermission('create_jobs');

  const [step, setStep] = useState<Step>('menu');
  const [startMinute, setStartMinute] = useState(initialStartMinute);
  const [endMinute, setEndMinute] = useState(initialEndMinute);
  const [conflicts, setConflicts] = useState<ScheduleAssignmentView[] | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);

  // Fresh per open — a re-tap on a different cell must not carry over the
  // last cell's step/range/conflict state.
  useEffect(() => {
    if (!visible) return;
    setStep('menu');
    setStartMinute(initialStartMinute);
    setEndMinute(initialEndMinute);
    setConflicts(null);
    setRetry(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initialStartMinute, initialEndMinute]);

  const jobOptions = useDbQuery<PickerOption[]>(
    () => getOpenJobs().map(j => ({ id: j.id, label: j.name })),
    [],
    ['jobs'],
  );
  const managers = useDbQuery(() => getAssignableManagers(), [], ['users']);

  function pickStart(minute: number) {
    const [s2, e2] = snapRange(minute, endMinute);
    setStartMinute(s2); setEndMinute(e2);
  }
  function pickEnd(minute: number) {
    const [s2, e2] = snapRange(startMinute, minute);
    setStartMinute(s2); setEndMinute(e2);
  }
  function extendBy(minutes: number) {
    const [s2, e2] = snapRange(startMinute, endMinute + minutes);
    setStartMinute(s2); setEndMinute(e2);
  }
  function allDay() {
    setStartMinute(DAY_START_MIN);
    setEndMinute(DAY_END_MIN);
  }

  // Caller-owned logging (see this file's header): the repo call + appendLog
  // for both the new assignment AND any force-cleared prior slot happen
  // inside ONE outer transaction (reentrant — merges with the repo's own
  // inner transaction into a single commit).
  function trySlotAssign(kind: 'job' | 'manager', jobId: string | undefined, managerId: string | undefined, force = false) {
    const userId = user?.id ?? null;
    try {
      runInTransaction(() => {
        const { id, cleared } = kind === 'job'
          ? assignJobSlot({ employeeId, day, startMinute, endMinute, jobId: jobId! }, userId, { force })
          : assignManagerSlot({ employeeId, day, startMinute, endMinute, managerId: managerId! }, userId, { force });
        for (const c of cleared) {
          appendLog({
            user_id: userId, team_id: null, action: 'schedule_cleared', entity_type: 'user',
            entity_id: c.employee_id, from_location_id: null, to_location_id: null,
            quantity: null, unit: null, job_id: c.job_id, note: null,
            metadata: JSON.stringify({ assignment_id: c.id, day: c.day, reason: 'overlap_replaced' }),
            device_id: null,
          });
        }
        appendLog({
          user_id: userId, team_id: null, action: 'schedule_assigned', entity_type: 'user',
          entity_id: employeeId, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: kind === 'job' ? jobId ?? null : null, note: null,
          metadata: JSON.stringify({ assignment_id: id, day, start_minute: startMinute, end_minute: endMinute, assignment_kind: kind, job_id: jobId ?? null, manager_id: managerId ?? null }),
          device_id: null,
        });
      });
      setConflicts(null);
      onClose();
    } catch (e) {
      if (e instanceof ScheduleConflictError) {
        setConflicts(e.conflicts);
        setRetry(() => () => trySlotAssign(kind, jobId, managerId, true));
        return;
      }
      throw e;
    }
  }

  function handlePmRowPress() {
    if (managers.length === 1) {
      trySlotAssign('manager', undefined, managers[0]!.id);
      return;
    }
    setStep('pm-list');
  }

  // #173 inline pinned "+ Create" — copies the DestinationPicker.createJob
  // local-write pattern (upsert + outbox INSERT + job_created log, wrapped in
  // one transaction so a mid-flow failure can't strand a job row without its
  // outbox entry). Distinct from the "Create a Job" menu row, which hands off
  // to the fuller JobQuickAdd form instead of this bare-name shortcut.
  function createJobInline(text: string) {
    if (!user) return;
    if (isWriteBlocked()) {
      Alert.alert('Maintenance in progress', 'Can’t create a job right now. Try again once maintenance finishes.');
      return;
    }
    const now = new Date().toISOString();
    const newJob: Job = {
      id: generateUUID(), name: text, status: 'open',
      created_by: user.id, created_at: now, updated_at: now, synced_at: null,
    } as Job;
    try {
      runInTransaction(() => {
        upsertJob(newJob);
        appendLog({
          action: 'job_created', entity_type: 'job', entity_id: newJob.id,
          user_id: realUser!.id, team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: newJob.id, note: newJob.name,
          metadata: null, device_id: null,
        });
      });
    } catch {
      Alert.alert('Couldn’t create job', 'Something went wrong saving the new job. Please try again.');
      return;
    }
    trySlotAssign('job', newJob.id, undefined);
  }

  function renderConflicts() {
    if (!conflicts) return null;
    return (
      <View style={s.conflictBox}>
        <Text style={s.conflictTitle}>{employeeName} already has:</Text>
        {conflicts.map(c => (
          <Text key={c.id} style={s.conflictLine}>
            {c.assignment_kind === 'job' ? (c.job_name ?? 'a job') : `PM · ${c.manager_name ?? 'a manager'}`}
            {'  '}{formatMinute(c.start_minute)}–{formatMinute(c.end_minute)}
          </Text>
        ))}
        <View style={s.conflictActions}>
          <TouchableOpacity onPress={() => { setConflicts(null); setRetry(null); }}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <PrimaryButton label="Replace" tone="danger" onPress={() => retry?.()} style={s.replaceBtn} />
        </View>
      </View>
    );
  }

  function renderRangeEditor() {
    return (
      <>
        <View style={s.rangeRow}>
          <TimeWheelPicker label="Start" valueMinute={startMinute} onChange={pickStart} />
          <Text style={s.rangeDash}>–</Text>
          <TimeWheelPicker label="End" valueMinute={endMinute} onChange={pickEnd} />
        </View>
        <View style={s.quickRow}>
          <TouchableOpacity style={s.quickChip} onPress={() => extendBy(60)}><Text style={s.quickChipText}>+1h</Text></TouchableOpacity>
          <TouchableOpacity style={s.quickChip} onPress={() => extendBy(120)}><Text style={s.quickChipText}>+2h</Text></TouchableOpacity>
          <TouchableOpacity style={s.quickChip} onPress={allDay}><Text style={s.quickChipText}>All day (8–5)</Text></TouchableOpacity>
        </View>
      </>
    );
  }

  function renderMenu() {
    return (
      <>
        <Text style={s.title}>Assign {employeeName} — {formatMinute(startMinute)}–{formatMinute(endMinute)}</Text>
        {renderRangeEditor()}
        <TouchableOpacity style={s.menuRow} onPress={() => setStep('job-search')}>
          <Text style={s.menuRowText}>Job</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.menuRow} onPress={handlePmRowPress}>
          <Text style={s.menuRowText}>Production Manager</Text>
        </TouchableOpacity>
        {canCreateJobs && (
          <TouchableOpacity style={s.menuRow} onPress={() => { onClose(); onCreateJob(startMinute, endMinute); }}>
            <Text style={s.menuRowText}>Create a Job</Text>
          </TouchableOpacity>
        )}
      </>
    );
  }

  function renderJobSearch() {
    return (
      <>
        <Text style={s.title}>Assign {employeeName} — {formatMinute(startMinute)}–{formatMinute(endMinute)}</Text>
        <SearchablePicker
          placeholder={canCreateJobs ? 'Search or create a job…' : 'Search jobs…'}
          options={jobOptions}
          value={null}
          onSelect={opt => trySlotAssign('job', opt.id, undefined)}
          onCreate={canCreateJobs ? createJobInline : undefined}
          autoFocus
        />
        <TouchableOpacity style={s.backRow} onPress={() => setStep('menu')}>
          <Text style={s.backText}>← Back</Text>
        </TouchableOpacity>
      </>
    );
  }

  function renderPmList() {
    return (
      <>
        <Text style={s.title}>Assign {employeeName} — {formatMinute(startMinute)}–{formatMinute(endMinute)}</Text>
        {managers.length === 0 ? (
          <Text style={s.emptyText}>No production managers available.</Text>
        ) : (
          managers.map(m => (
            <TouchableOpacity key={m.id} style={s.menuRow} onPress={() => trySlotAssign('manager', undefined, m.id)}>
              <Text style={s.menuRowText}>{m.name}</Text>
            </TouchableOpacity>
          ))
        )}
        <TouchableOpacity style={s.backRow} onPress={() => setStep('menu')}>
          <Text style={s.backText}>← Back</Text>
        </TouchableOpacity>
      </>
    );
  }

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      {conflicts ? renderConflicts() : (
        step === 'menu' ? renderMenu() : step === 'job-search' ? renderJobSearch() : renderPmList()
      )}
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  title: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.md },
  rangeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: t.spacing.md, marginBottom: t.spacing.sm },
  rangeDash: { fontSize: t.typography.fontSizes.body, color: t.colors.textMuted },
  quickRow: { flexDirection: 'row', justifyContent: 'center', gap: t.spacing.sm, marginBottom: t.spacing.lg },
  quickChip: {
    paddingHorizontal: t.spacing.md, paddingVertical: t.spacing.xs, borderRadius: t.radii.pill,
    backgroundColor: t.colors.primaryBg,
  },
  quickChipText: { fontSize: t.typography.fontSizes.caption, color: t.colors.primaryText, fontWeight: '600' },
  menuRow: {
    paddingVertical: t.spacing.md, paddingHorizontal: t.spacing.sm,
    borderBottomWidth: 1, borderBottomColor: t.colors.borderDetail,
  },
  menuRowText: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary },
  backRow: { marginTop: t.spacing.lg },
  backText: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, fontWeight: '600' },
  emptyText: { fontSize: t.typography.fontSizes.body, color: t.colors.textMuted, marginVertical: t.spacing.md },
  conflictBox: {
    backgroundColor: t.colors.dangerBg, borderRadius: t.radii.md, padding: t.spacing.base,
  },
  conflictTitle: { fontSize: t.typography.fontSizes.body, fontWeight: '700', color: t.colors.danger, marginBottom: t.spacing.sm },
  conflictLine: { fontSize: t.typography.fontSizes.body2, color: t.colors.danger, marginBottom: t.spacing.xs },
  conflictActions: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: t.spacing.lg, marginTop: t.spacing.md },
  cancelText: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, fontWeight: '600' },
  replaceBtn: { minWidth: 100 },
});
