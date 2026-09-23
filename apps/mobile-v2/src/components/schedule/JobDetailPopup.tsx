import { useRouter } from 'expo-router';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles, ModalSheet, PrimaryButton, FieldLabel, confirmSheet } from '@invenpro/ui';
import { useDbQuery, runInTransaction } from '@invenpro/core';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { JobSummaryCard } from '../jobs/JobSummaryCard';
import { getJobById, getAssignmentsForJob } from '../../repos/jobs';
import { appendLog } from '../../db/queries/log';
import { clearSlot } from '../../repos/schedule';

interface Props {
  visible: boolean;
  onClose: () => void;
  jobId: string;
  /** The schedule_assignments row backing this chip — "Clear this slot" clears THIS row, not the job. */
  assignmentId: string;
}

// Station C2: ported from apps/mobile/src/components/schedule/
// JobDetailPopup.tsx. Import mapping: '../ui/*' -> '@invenpro/ui',
// '../../db/queries/jobs'.getAssignmentsForJob -> repos/jobs's OWN
// getAssignmentsForJob (jobs.ts already exports one — no separate
// jobAssignments module in mobile-v2, see jobs.test.ts), '../../db/queries/
// schedule' -> '../../repos/schedule'. Route path updated to the typed
// '/(app)/jobs/[id]' object form (jobs/index.tsx precedent) since mobile-v2
// dropped the old app's parenthesized (jobs) route group.
//
// Behavior change (no-self-log convention): clearSlot() no longer logs
// 'schedule_cleared' itself (nor takes an actorId) — this handler now builds
// that log entry, wrapped in the SAME runInTransaction clearSlot already
// opens internally (reentrant -> one commit).
export function JobDetailPopup({ visible, onClose, jobId, assignmentId }: Props) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const canOpenJob = usePermission('create_jobs');
  const canEdit = usePermission('manage_schedule');

  const job = useDbQuery(() => getJobById(jobId), [jobId], ['jobs']);
  const crews = useDbQuery(() => getAssignmentsForJob(jobId), [jobId], ['job_assignments']);

  async function handleClear() {
    const ok = await confirmSheet({
      title: 'Clear this slot?',
      message: 'The employee will no longer show as assigned to this job at this time.',
      confirmLabel: 'Clear',
      destructive: true,
    });
    if (!ok) return;
    runInTransaction(() => {
      const cleared = clearSlot(assignmentId);
      if (!cleared) return; // already cleared (double-tap) — no-op, nothing to log
      appendLog({
        user_id: user?.id ?? null, team_id: null, action: 'schedule_cleared', entity_type: 'user',
        entity_id: cleared.employee_id, from_location_id: null, to_location_id: null,
        quantity: null, unit: null, job_id: cleared.job_id, note: null,
        metadata: JSON.stringify({ assignment_id: cleared.id, day: cleared.day, reason: 'manual_clear' }),
        device_id: null,
      });
    });
    onClose();
  }

  function handleOpenJob() {
    onClose();
    router.push({ pathname: '/(app)/jobs/[id]', params: { id: jobId } });
  }

  return (
    <ModalSheet visible={visible} onClose={onClose}>
      {job ? (
        <>
          <JobSummaryCard job={job} />
          <FieldLabel style={s.sectionLabel}>Assigned crews</FieldLabel>
          {crews.length === 0 ? (
            <Text style={s.emptyText}>No crews assigned.</Text>
          ) : (
            crews.map(c => (
              <Text key={c.id} style={s.crewRow}>{c.assignee_name}</Text>
            ))
          )}
          <View style={s.actions}>
            {canOpenJob && (
              <TouchableOpacity onPress={handleOpenJob}>
                <Text style={s.linkText}>Open full job →</Text>
              </TouchableOpacity>
            )}
            {canEdit && (
              <PrimaryButton label="Clear this slot" tone="danger" onPress={handleClear} style={s.clearBtn} />
            )}
          </View>
        </>
      ) : (
        <Text style={s.emptyText}>Job not found.</Text>
      )}
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  sectionLabel: { marginTop: t.spacing.lg, marginBottom: t.spacing.sm },
  emptyText: { fontSize: t.typography.fontSizes.body, color: t.colors.textMuted },
  crewRow: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, paddingVertical: t.spacing.xs },
  actions: { marginTop: t.spacing.xl, gap: t.spacing.md },
  linkText: { fontSize: t.typography.fontSizes.body, color: t.colors.primaryText, fontWeight: '600' },
  clearBtn: { marginTop: t.spacing.sm },
});
