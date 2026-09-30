import { useRouter } from 'expo-router';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { useDbQuery } from '../../hooks/useDbQuery';
import { ModalSheet } from '../ui/ModalSheet';
import { PrimaryButton } from '../ui/PrimaryButton';
import { FieldLabel } from '../ui/FieldLabel';
import { confirmSheet } from '../ui/ConfirmSheet';
import { JobSummaryCard } from '../jobs/JobSummaryCard';
import { getJobById } from '../../db/queries/jobs';
import { getAssignmentsForJob } from '../../db/queries/jobAssignments';
import { clearSlot } from '../../db/queries/schedule';

interface Props {
  visible: boolean;
  onClose: () => void;
  jobId: string;
  /** The schedule_assignments row backing this chip — "Clear this slot" clears THIS row, not the job. */
  assignmentId: string;
}

// #184: read-only job info + crew roster for a tapped JOB chip on the
// schedule board, plus editor-only actions. JobSummaryCard is the same
// component (jobs)/[id].tsx renders — one source of truth for the job
// header (name/status/site/map/etc.), not a forked summary.
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
    clearSlot(assignmentId, user?.id ?? null);
    onClose();
  }

  function handleOpenJob() {
    onClose();
    router.push(`/(app)/(jobs)/${jobId}`);
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
