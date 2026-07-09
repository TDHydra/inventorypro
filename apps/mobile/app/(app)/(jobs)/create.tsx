import { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import {
  upsertJob, Job,
  getDistinctCustomerNames, getDistinctInsuranceCarriers, getDistinctSiteAddresses,
  getLatestJobByCustomer,
} from '../../../src/db/queries/jobs';
import { appendLog } from '../../../src/db/queries/log';
import { appendOutbox } from '../../../src/sync/outbox';
import { runInTransaction } from '../../../src/db/tx';
import { getAllLocations } from '../../../src/db/queries/locations';
import { getTaxonomyTypes, getTaxonomyTypesWithFallback } from '../../../src/db/queries/taxonomy';
import { renderIcon } from '../../../src/constants/locationStyles';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { SuggestInput } from '../../../src/components/SuggestInput';
import { generateUUID } from '../../../src/utils/uuid';
import { colors } from '../../../src/theme';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import { AdvancedFields } from '../../../src/components/ui/AdvancedFields';
import { HidableField } from '../../../src/components/ui/HidableField';

export default function CreateJobScreen() {
  const { user } = useSession();
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

  const jobTypes = useMemo(() => getTaxonomyTypesWithFallback('job'), []);
  const [type, setType] = useState<string | null>(() => {
    const ts = getTaxonomyTypes('job');
    return ts[0]?.label ?? null;
  });

  const locationOptions = useMemo((): PickerOption[] => {
    return getAllLocations().map(l => ({ id: l.id, label: l.name }));
  }, []);

  // Prior values for the typeahead dropdowns.
  const customerOptions = useMemo(() => getDistinctCustomerNames(), []);
  const carrierOptions = useMemo(() => getDistinctInsuranceCarriers(), []);
  const addressOptions = useMemo(() => getDistinctSiteAddresses(), []);

  // When an existing customer is picked, offer (with confirmation) to fill that
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
      <KeyboardAvoidingView
        style={s.container}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">

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
              <FieldLabel>Type</FieldLabel>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={s.chipRow}
              >
                {jobTypes.map(t => (
                  <FilterChip
                    key={t.label}
                    label={`${renderIcon(t.icon)} ${t.label}`}
                    active={type === t.label}
                    onPress={() => setType(prev => prev === t.label ? null : t.label)}
                  />
                ))}
              </ScrollView>
            </View>
          )}

          <AdvancedFields>
            <HidableField fieldId="jobs.customer_name">
              <View style={s.fieldWrap}>
                <FieldLabel>Customer Name</FieldLabel>
                <SuggestInput
                  value={customerName}
                  onChange={setCustomerName}
                  onPick={offerCrossFill}
                  suggestions={customerOptions}
                  placeholder="Customer or company name"
                />
              </View>
            </HidableField>

            <HidableField fieldId="jobs.site_address">
              <View style={s.fieldWrap}>
                <FieldLabel>Site Address</FieldLabel>
                <SuggestInput
                  value={siteAddress}
                  onChange={setSiteAddress}
                  suggestions={addressOptions}
                  placeholder="Street address or description"
                />
              </View>
            </HidableField>

            <HidableField fieldId="jobs.site_location">
              <View style={s.fieldWrap}>
                <FieldLabel>Site Location</FieldLabel>
                <SearchablePicker
                  placeholder="Search locations..."
                  options={locationOptions}
                  value={siteLocation}
                  onSelect={opt => setSiteLocation(prev => prev?.id === opt.id ? null : opt)}
                />
              </View>
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
              <View style={s.fieldWrap}>
                <FieldLabel>Insurance carrier</FieldLabel>
                <SuggestInput
                  value={insuranceCarrier}
                  onChange={setInsuranceCarrier}
                  suggestions={carrierOptions}
                  placeholder="Insurance company"
                />
              </View>
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

        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 16, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  muted: { fontSize: 14, color: colors.textMuted, textAlign: 'center' },

  hint: {
    backgroundColor: colors.primaryBg,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.primaryBgStrong,
    padding: 12,
  },
  hintText: { fontSize: 13, color: colors.primaryText },

  fieldWrap: { gap: 6 },
  chipRow: { gap: 8, paddingRight: 8 },
  textArea: { height: 100, paddingTop: 12, paddingBottom: 12 },

  row: { flexDirection: 'row', gap: 12, marginTop: 8 },
  btnGhost: {
    borderRadius: 12, paddingVertical: 13, alignItems: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.textDisabled,
  },
  btnGhostText: { color: '#475569', fontWeight: '600', fontSize: 16 },
});
