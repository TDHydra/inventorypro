import { useState, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import { generateUUID } from '../../utils/uuid';
import {
  upsertJob, Job,
  getLatestJobByCustomer,
} from '../../db/queries/jobs';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { useTableVersion } from '../../hooks/useDataVersion';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../db/maintenance';
import { getTaxonomyTypes } from '../../db/queries/taxonomy';
import { PickerOption } from '../SearchablePicker';
import { LocationPicker, TaxonomyChips } from '../pickers';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { AppInput } from '../ui/AppInput';
import { FieldLabel } from '../ui/FieldLabel';
import { FormScreen } from '../ui/FormScreen';
import { AdvancedFields } from '../ui/AdvancedFields';
import { PermissionGate } from '../PermissionGate';
import { QuickAddFooter } from './QuickAddFooter';
import { AutofillTextField } from '../ui/AutofillTextField';
import { TextField } from '../ui/TextField';
import { track } from '../../telemetry';
import { validateName, validateText } from '../../lib/validation';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

// Audit a validation rejection — field path + rule name ONLY, never the value.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'quick_add', props: { field, rule } });
}

export default function JobQuickAdd({ onSaved }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const { locked } = useMaintenanceMode();

  const [name, setName] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [siteLocation, setSiteLocation] = useState<PickerOption | null>(null);
  const [description, setDescription] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [insuranceCarrier, setInsuranceCarrier] = useState('');
  const [nameError, setNameError] = useState('');
  // Increment to remount the name input (autoFocus) after each save.
  const [formKey, setFormKey] = useState(0);

  // Re-read the job-type chips when a sync pull touches the taxonomy.
  const taxonomyVersion = useTableVersion(['taxonomy_types']);
  const jobTypes = useMemo(() => getTaxonomyTypes('job'), [taxonomyVersion]);
  const [type, setType] = useState<string | null>(() => {
    const ts = getTaxonomyTypes('job');
    return ts[0]?.label ?? null;
  });

  // When an existing customer is picked, offer (with confirmation) to fill in that
  // customer's last-job details — only fields that are still empty.
  function offerCrossFill(picked: string) {
    const d = getLatestJobByCustomer(picked);
    if (!d) return;
    const willAddr = !siteAddress.trim() && !!d.site_address;
    const willCarrier = !insuranceCarrier.trim() && !!d.insurance_carrier;
    const willLoc = !siteLocation && !!d.site_location_id;
    if (!willAddr && !willCarrier && !willLoc) return;
    const lines: string[] = [];
    if (willAddr) lines.push(`Address: ${d.site_address}`);
    if (willCarrier) lines.push(`Carrier: ${d.insurance_carrier}`);
    if (willLoc) lines.push(`Site: ${d.site_location_label ?? '—'}`);
    Alert.alert(
      `Use ${picked}'s details from their last job?`,
      lines.join('\n'),
      [
        { text: 'Skip', style: 'cancel' },
        {
          text: 'Fill them in',
          onPress: () => {
            if (willAddr) setSiteAddress(d.site_address!);
            if (willCarrier) setInsuranceCarrier(d.insurance_carrier!);
            if (willLoc) setSiteLocation({ id: d.site_location_id!, label: d.site_location_label ?? d.site_location_id! });
          },
        },
      ],
    );
  }

  function handleSave() {
    track('action', 'quickadd_save_job', { screen: 'quick_add' });
    if (isWriteBlocked()) return;
    // Bounded, control-char-free name (same 'Job name is required.' copy as
    // before for the blank case).
    const nameResult = validateName(name, { label: 'Job name' });
    if (!nameResult.ok) {
      trackReject('job.name', nameResult.rule);
      setNameError(nameResult.error);
      return;
    }
    const trimmedName = nameResult.value;
    if (!user) {
      Alert.alert('Error', 'Not logged in.');
      return;
    }
    setNameError('');

    // Optional free-text fields: bounded + control-char-rejecting, checked
    // BEFORE any local write. Blank stays fine (→ null below, as before).
    const textChecks = [
      { field: 'job.customer_name', value: customerName, label: 'Customer name', max: 200 },
      { field: 'job.site_address', value: siteAddress, label: 'Site address', max: 500 },
      { field: 'job.reference_number', value: referenceNumber, label: 'Reference #', max: 100 },
      { field: 'job.insurance_carrier', value: insuranceCarrier, label: 'Insurance carrier', max: 200 },
      { field: 'job.description', value: description, label: 'Description', max: 2000 },
    ] as const;
    for (const c of textChecks) {
      const r = validateText(c.value, { label: c.label, max: c.max });
      if (!r.ok) {
        trackReject(c.field, r.rule);
        Alert.alert(`Check ${c.label.toLowerCase()}`, r.error);
        return;
      }
    }

    const now = new Date().toISOString();
    const id = generateUUID();
    const newJob: Job = {
      id,
      name: trimmedName,
      status: 'open',
      created_by: user.id,
      created_at: now,
      updated_at: now,
      synced_at: null,
      job_number: null,
      customer_name: customerName.trim() || null,
      site_address: siteAddress.trim() || null,
      site_location_id: siteLocation?.id ?? null,
      description: description.trim() || null,
      type: type || null,
      reference_number: referenceNumber.trim() || null,
      insurance_carrier: insuranceCarrier.trim() || null,
    };

    upsertJob(newJob);
    appendOutbox('INSERT', 'jobs', {
      id: newJob.id,
      name: newJob.name,
      status: newJob.status,
      created_by: newJob.created_by,
      created_at: newJob.created_at,
      updated_at: newJob.updated_at,
      // Omit job_number entirely: the server's BEFORE INSERT trigger assigns it.
      // Including it (even as null) would let an at-least-once redelivery's
      // ON CONFLICT upsert overwrite the already-assigned number (churn).
      customer_name: newJob.customer_name,
      site_address: newJob.site_address,
      site_location_id: newJob.site_location_id,
      description: newJob.description,
      type: newJob.type,
      reference_number: newJob.reference_number,
      insurance_carrier: newJob.insurance_carrier,
    });
    appendLog({
      action: 'job_created',
      entity_type: 'job',
      entity_id: id,
      user_id: user.id,
      note: trimmedName,
      team_id: null,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: id,
      metadata: null,
      device_id: null,
    });

    onSaved(trimmedName, id);

    // Clear per-job fields for the next entry; keep `type` sticky.
    setName('');
    setCustomerName('');
    setSiteAddress('');
    setSiteLocation(null);
    setDescription('');
    setReferenceNumber('');
    setInsuranceCarrier('');
    setFormKey(k => k + 1);
  }

  return (
    // Owns its FormScreen (shell passes wrapForm={false}) so the save bar sits
    // in the sticky footer slot and floats above the keyboard (#118). Job
    // quick-add historically has no Done row (header back exits), so showDone
    // is off.
    <FormScreen
      contentContainerStyle={s.content}
      footer={(
        // server requires create_jobs to accept the push (syncPolicy.ts:331) —
        // gate the save control so a denied user learns why instead of hitting
        // a sync conflict (#76).
        <PermissionGate permission="create_jobs" mode="disable">
          <QuickAddFooter onSave={handleSave} disabled={locked} locked={locked} showDone={false} />
        </PermissionGate>
      )}
    >
      <View style={s.hint}>
        <Text style={s.hintText}>
          The job number is assigned automatically after the next sync.
        </Text>
      </View>

      <View style={s.fieldWrap}>
        <FieldLabel>Job Name *</FieldLabel>
        <AppInput
          key={formKey}
          value={name}
          onChangeText={t => { setName(t); if (nameError) setNameError(''); }}
          placeholder="Enter job name"
          autoFocus
          returnKeyType="done"
          onSubmitEditing={handleSave}
          style={!!nameError && s.inputError}
        />
        {!!nameError && <Text style={s.errorText}>{nameError}</Text>}
      </View>

      {jobTypes.length > 0 && (
        <View style={s.fieldWrap}>
          <TaxonomyChips
            category="job"
            label="Type"
            valueLabel={type}
            onChange={v => setType(v.label)}
            deselectable
          />
        </View>
      )}

      <AdvancedFields>
        <AutofillTextField
          label="Customer Name"
          table="jobs"
          column="customer_name"
          value={customerName}
          onChangeText={setCustomerName}
          onPick={offerCrossFill}
          placeholder="Customer or company name"
        />

        <AutofillTextField
          label="Site Address"
          table="jobs"
          column="site_address"
          value={siteAddress}
          onChangeText={setSiteAddress}
          placeholder="Street address or description"
        />

        <LocationPicker
          label="Site Location"
          placeholder="Search locations..."
          value={siteLocation}
          onChange={setSiteLocation}
        />

        {/* Reference numbers are per-job unique — never suggest other jobs' values. */}
        <TextField
          label="Reference # (external)"
          value={referenceNumber}
          onChangeText={setReferenceNumber}
          placeholder="Insurance claim / customer PO #"
          autoCapitalize="characters"
        />

        <AutofillTextField
          label="Insurance carrier"
          table="jobs"
          column="insurance_carrier"
          value={insuranceCarrier}
          onChangeText={setInsuranceCarrier}
          placeholder="Insurance company"
        />

        <View style={s.fieldWrap}>
          <FieldLabel>Description</FieldLabel>
          <AppInput
            style={s.textArea}
            value={description}
            onChangeText={setDescription}
            placeholder="Job description or notes"
            multiline
            numberOfLines={4}
            textAlignVertical="top"
          />
        </View>
      </AdvancedFields>
    </FormScreen>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // Mirrors the shell's default FormScreen content padding + this form's row gap.
  content: { padding: t.spacing.lg, paddingBottom: 48, gap: 12 },
  hint: {
    backgroundColor: t.colors.primaryBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: t.colors.primaryBgStrong,
    padding: 12,
  },
  hintText: { fontSize: 13, color: t.colors.primaryText },
  fieldWrap: { gap: 6 },
  textArea: { height: 100, paddingTop: 12, paddingBottom: 12 },
  inputError: { borderColor: t.colors.danger },
  errorText: { fontSize: t.typography.fontSizes.caption, color: t.colors.danger },
});
