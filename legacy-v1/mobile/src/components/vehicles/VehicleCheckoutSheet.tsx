import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { EntityEditSheet } from '../ui/EntityEditSheet';
import { SelectField, type SelectOption } from '../ui/SelectField';
import { getOpenJobs } from '../../db/queries/jobs';
import {
  checkOutVehicle, takeOverVehicle, addJobToActiveCheckout,
} from '../../db/queries/vehicles';
import { useSession } from '../../hooks/useSession';
import { isWriteBlocked } from '../../db/maintenance';
import { useDbQuery } from '../../hooks/useDbQuery';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

/**
 * The one job-picking sheet for vehicle sessions. Three modes, all sharing the
 * optional job SelectField:
 *   checkout — open a fresh session for the current user
 *   takeover — close the holder's stale session then open a fresh one
 *              (the panel has ALREADY warned via confirmSheet before opening
 *              this sheet in takeover mode — no second confirm here)
 *   addjob   — attach/change the job on the caller's open session
 */
export type CheckoutSheetMode = 'checkout' | 'takeover' | 'addjob';

interface Props {
  locationId: string;
  visible: boolean;
  onClose: () => void;
  mode: CheckoutSheetMode;
  /** Required for addjob — the caller's open session. */
  sessionId?: string;
  /** Pre-selected job (addjob mode shows the session's current job). */
  initialJobId?: string | null;
}

const TITLES: Record<CheckoutSheetMode, string> = {
  checkout: 'Check Out Vehicle',
  takeover: 'Take Over Vehicle',
  addjob: 'Add Job',
};
const SAVE_LABELS: Record<CheckoutSheetMode, string> = {
  checkout: 'Check Out',
  takeover: 'Take Over',
  addjob: 'Save',
};

export function VehicleCheckoutSheet({
  locationId, visible, onClose, mode, sessionId, initialJobId,
}: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const [jobId, setJobId] = useState<string | null>(initialJobId ?? null);

  // Re-seed the picker on each open (the component stays mounted while hidden).
  useEffect(() => {
    if (visible) setJobId(initialJobId ?? null);
  }, [visible, initialJobId]);

  // Re-runs whenever a local write OR a background sync pull touches jobs
  // (#60/#63) — no manual reload key needed.
  const jobOptions = useDbQuery<SelectOption[]>(
    () => (visible ? getOpenJobs().map(j => ({
      id: j.id,
      label: j.name,
      sublabel: [j.job_number, j.customer_name].filter(Boolean).join(' · ') || undefined,
    })) : []),
    [visible],
    ['jobs'],
  );

  function save() {
    if (isWriteBlocked()) throw new Error('read-only');
    if (mode === 'addjob') {
      if (!sessionId) return;
      addJobToActiveCheckout(sessionId, jobId);
      return;
    }
    if (!user) return;
    if (mode === 'takeover') {
      takeOverVehicle(locationId, jobId, user.id);
      return;
    }
    checkOutVehicle(locationId, jobId, user.id);
  }

  return (
    <EntityEditSheet
      visible={visible}
      onClose={onClose}
      title={TITLES[mode]}
      onSave={save}
      saveLabel={SAVE_LABELS[mode]}
    >
      <View style={s.body}>
        {mode !== 'addjob' && (
          <Text style={s.hint}>
            The vehicle is checked out to you until you check it back in.
          </Text>
        )}
        <SelectField
          label="Job (optional)"
          value={jobId}
          options={jobOptions}
          onSelect={setJobId}
          onClear={() => setJobId(null)}
          placeholder="No job"
        />
      </View>
    </EntityEditSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  body: { gap: t.spacing.md, marginBottom: t.spacing.sm },
  hint: { fontSize: t.typography.fontSizes.sm, color: t.colors.textSecondary, lineHeight: 18 },
});
