import { useState, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  Alert, AppInput, FieldLabel, FormScreen, TextField, useThemedStyles, type Theme,
} from '@invenpro/ui';
import { generateUUID } from '../../utils/uuid';
import {
  upsertJob, getLatestJobByCustomer, type Job,
} from '../../repos/jobs';
import { useSession } from '../../hooks/useSession';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../db/maintenance';
import { getTaxonomyTypes } from '../../repos/taxonomy';
import { runInTransaction } from '@invenpro/core';
import { appendLog } from '../../db/queries/log';
import { PickerOption } from '../SearchablePicker';
import { LocationPicker, TaxonomyChips } from '../pickers';
import { AdvancedFields } from '../ui/AdvancedFields';
import { AutofillTextField } from '../ui/AutofillTextField';
import { PermissionGate } from '../PermissionGate';
import { QuickAddFooter } from './QuickAddFooter';
import { track } from '../../telemetry';
import { validateName, validateText } from '../../lib/validation';

// Ported from apps/mobile/src/components/quickadd/JobQuickAdd.tsx (325 ln).
// The old app ALSO had a full-page create screen ((jobs)/create.tsx, 347 ln,
// team-picker + AdvancedFields toggle) that duplicated ~80% of this form's
// logic. This wave consolidates on ONE canonical create path — this component
// — reused both from the global Quick Add launcher (QuickCreateSheet's 'job'
// case) AND from jobs/index.tsx's "+ New Job" button (a ModalSheet, not a
// separate route) — kit rule: grow/reuse, never fork a surface. The old
// create.tsx's org-authority team picker is dropped: jobs/[id].tsx still
// offers "Change Team" post-creation for the same tier>=3 audience, so no
// capability is lost, just deferred one screen.
//
// Also fixes a real bug carried in the old JobQuickAdd: its three writes
// (upsertJob / outbox / log) were NOT wrapped in runInTransaction (unlike
// create.tsx's atomic version) — a crash between them could leave a job with
// no audit trail. This port wraps them atomically like every other Wave
// B/C quickadd form.

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'quick_add', props: { field, rule } });
}

export default function JobQuickAdd({ onSaved }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();

  const [name, setName] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [siteLocation, setSiteLocation] = useState<PickerOption | null>(null);
  const [description, setDescription] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [insuranceCarrier, setInsuranceCarrier] = useState('');
  const [nameError, setNameError] = useState('');
  const [formKey, setFormKey] = useState(0);

  const jobTypes = useMemo(() => getTaxonomyTypes('job'), []);
  const [type, setType] = useState<string | null>(() => getTaxonomyTypes('job')[0]?.label ?? null);

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

    try {
      runInTransaction(() => {
        upsertJob(newJob);
        appendLog({
          action: 'job_created',
          entity_type: 'job',
          entity_id: id,
          user_id: realUser!.id,
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
      });
    } catch (e) {
      Alert.alert('Could not save job', e instanceof Error ? e.message : 'Please try again.');
      return;
    }

    onSaved(trimmedName, id);

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
    <FormScreen
      contentContainerStyle={s.content}
      footer={(
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
