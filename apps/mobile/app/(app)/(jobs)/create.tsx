import { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import {
  upsertJob, Job,
  getCustomersWithLatestJobDetails, CustomerAutofillRecord,
} from '../../../src/db/queries/jobs';
import { appendLog } from '../../../src/db/queries/log';
import { appendOutbox } from '../../../src/sync/outbox';
import { runInTransaction } from '../../../src/db/tx';
import { getAllTeams } from '../../../src/db/queries/teams';
import { getTaxonomyTypes, getTaxonomyTypesWithFallback } from '../../../src/db/queries/taxonomy';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { LocationPicker, TaxonomyChips } from '../../../src/components/pickers';
import { generateUUID } from '../../../src/utils/uuid';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FormScreen } from '../../../src/components/ui/FormScreen';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import { AdvancedFields } from '../../../src/components/ui/AdvancedFields';
import { HidableField } from '../../../src/components/ui/HidableField';
import { RecordAutofillInput, RecordOption } from '../../../src/components/ui/RecordAutofillInput';
import { AutofillTextField } from '../../../src/components/ui/AutofillTextField';
import { useTableVersion } from '../../../src/hooks/useDataVersion';

export default function CreateJobScreen() {
  const s = useThemedStyles(makeStyles);
  const { user, realUser } = useSession();
  const router = useRouter();
  const canCreate = usePermission('create_jobs');
  const { locked } = useMaintenanceMode();

  const [name, setName] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [siteLocation, setSiteLocation] = useState<PickerOption | null>(null);
  const [description, setDescription] = useState('');
  const [referenceNumber, setReferenceNumber] = useState('');
  const [insuranceCarrier, setInsuranceCarrier] = useState('');
  // Optional owning team. null = org-wide (visible to everyone).
  const [team, setTeam] = useState<PickerOption | null>(null);

  // Re-read the option lists when a sync pull touches their tables so a team,
  // job type or customer added elsewhere shows up while this form is open.
  const optionsVersion = useTableVersion(['teams', 'taxonomy_types', 'jobs']);

  // Only teams this device actually holds are offerable — a non-org user's scoped
  // pull leaves only their own teams here, so they can't assign to a team they
  // don't belong to.
  const teamOptions = useMemo((): PickerOption[] =>
    getAllTeams().map(t => ({ id: t.id, label: t.name })), [optionsVersion]);

  const jobTypes = useMemo(() => getTaxonomyTypesWithFallback('job'), [optionsVersion]);
  const [type, setType] = useState<string | null>(() => {
    const ts = getTaxonomyTypes('job');
    return ts[0]?.label ?? null;
  });

  // Every prior customer, each paired with the full details of their last job —
  // feeds RecordAutofillInput below.
  const customerOptions = useMemo((): RecordOption<CustomerAutofillRecord>[] =>
    getCustomersWithLatestJobDetails().map(c => ({
      label: c.customer_name,
      sublabel: c.site_address ?? undefined,
      record: c,
    })), [optionsVersion]);

  // When an existing customer is picked and confirmed, fill that customer's
  // last-job details — only fields that are still empty. Mirrors the old
  // hand-rolled `offerCrossFill`, minus its skip-the-confirm-entirely case:
  // RecordAutofillInput always confirms on a pick, even when (rarely) there'd
  // be nothing left to fill.
  function fillFromCustomer(d: CustomerAutofillRecord) {
    if (!siteAddress.trim() && d.site_address) setSiteAddress(d.site_address);
    if (!insuranceCarrier.trim() && d.insurance_carrier) setInsuranceCarrier(d.insurance_carrier);
    if (!siteLocation && d.site_location_id) {
      setSiteLocation({ id: d.site_location_id, label: d.site_location_label ?? d.site_location_id });
    }
  }

  function handleSave() {
    if (isWriteBlocked()) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert('Required', 'Job name is required.');
      return;
    }
    if (!user) {
      Alert.alert('Error', 'Not logged in.');
      return;
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
      team_id: team?.id ?? null,
    };

    // All three writes (row + outbox + audit log) must land together; on any
    // failure roll back and keep the user on the form rather than navigating to
    // a job that didn't actually save.
    try {
      runInTransaction(() => {
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
          team_id: newJob.team_id,
        });
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
      Alert.alert('Could not create job', e instanceof Error ? e.message : 'The job could not be saved. Please try again.');
      return;
    }

    router.replace({ pathname: '/(app)/(jobs)/[id]', params: { id } });
  }

  if (!canCreate) {
    return (
      <>
        <Stack.Screen options={{ title: 'New Job', headerShown: true }} />
        <View style={s.center}>
          <Text style={s.muted}>You do not have permission to create jobs.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: 'New Job', headerShown: true }} />
      <FormScreen contentContainerStyle={s.content}>

          <View style={s.hint}>
            <Text style={s.hintText}>
              The job number is assigned automatically after the next sync.
            </Text>
          </View>

          <View style={s.fieldWrap}>
            <FieldLabel>Job Name *</FieldLabel>
            <AppInput
              value={name}
              onChangeText={setName}
              placeholder="Enter job name"
              autoFocus
            />
          </View>

          {jobTypes.length > 0 && (
            <View style={s.fieldWrap}>
              <TaxonomyChips
                category="job"
                label="Type"
                withFallback
                deselectable
                valueLabel={type}
                onChange={v => setType(v.label)}
              />
            </View>
          )}

          {teamOptions.length > 0 && (
            <View style={s.fieldWrap}>
              <FieldLabel>Team</FieldLabel>
              <SearchablePicker
                placeholder="No team (visible to everyone)"
                options={teamOptions}
                value={team}
                onSelect={opt => setTeam(prev => prev?.id === opt.id ? null : opt)}
              />
              <Text style={s.teamHint}>
                {team ? 'Only this team will see the job.' : 'Visible to everyone (org-wide).'}
              </Text>
            </View>
          )}

          <AdvancedFields>
            <HidableField fieldId="jobs.customer_name">
              <RecordAutofillInput
                label="Customer Name"
                value={customerName}
                onChangeText={setCustomerName}
                options={customerOptions}
                onAutofill={fillFromCustomer}
                confirmTitle="Use this customer's details from their last job?"
                placeholder="Customer or company name"
              />
            </HidableField>

            <HidableField fieldId="jobs.site_address">
              <AutofillTextField
                label="Site Address"
                table="jobs"
                column="site_address"
                value={siteAddress}
                onChangeText={setSiteAddress}
                placeholder="Street address or description"
              />
            </HidableField>

            <HidableField fieldId="jobs.site_location">
              <LocationPicker
                label="Site Location"
                placeholder="Search locations..."
                value={siteLocation}
                onChange={setSiteLocation}
              />
            </HidableField>

            <HidableField fieldId="jobs.reference_number">
              <View style={s.fieldWrap}>
                <FieldLabel>Reference # (external)</FieldLabel>
                <AppInput
                  value={referenceNumber}
                  onChangeText={setReferenceNumber}
                  placeholder="Insurance claim / customer PO #"
                  autoCapitalize="characters"
                />
              </View>
            </HidableField>

            <HidableField fieldId="jobs.insurance_carrier">
              <AutofillTextField
                label="Insurance carrier"
                table="jobs"
                column="insurance_carrier"
                value={insuranceCarrier}
                onChangeText={setInsuranceCarrier}
                placeholder="Insurance company"
              />
            </HidableField>

            <HidableField fieldId="jobs.description">
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
            </HidableField>
          </AdvancedFields>

          <View style={s.row}>
            <TouchableOpacity style={[s.btnGhost, { flex: 1 }]} onPress={() => router.back()}>
              <Text style={s.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <PrimaryButton
              label="Create Job"
              onPress={handleSave}
              disabled={locked}
              style={{ flex: 1 }}
            />
          </View>
          {locked && <MaintenanceBanner />}

      </FormScreen>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  content: { padding: 16, gap: 16, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  muted: { fontSize: 14, color: t.colors.textMuted, textAlign: 'center' },

  hint: {
    backgroundColor: t.colors.primaryBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: t.colors.primaryBgStrong,
    padding: 12,
  },
  hintText: { fontSize: 13, color: t.colors.primaryText },

  fieldWrap: { gap: 6 },
  teamHint: { fontSize: 12, color: t.colors.textMuted },
  textArea: { height: 100, paddingTop: 12, paddingBottom: 12 },

  row: { flexDirection: 'row', gap: 12, marginTop: 8 },
  btnGhost: {
    borderRadius: 12, paddingVertical: 13, alignItems: 'center',
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.textDisabled,
  },
  btnGhostText: { color: '#475569', fontWeight: '600', fontSize: 16 },
});
