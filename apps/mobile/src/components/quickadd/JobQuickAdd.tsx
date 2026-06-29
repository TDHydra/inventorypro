import { useState, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import { generateUUID } from '../../utils/uuid';
import {
  upsertJob, Job,
  getDistinctCustomerNames, getDistinctInsuranceCarriers, getDistinctSiteAddresses,
  getLatestJobByCustomer,
} from '../../db/queries/jobs';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { useSession } from '../../hooks/useSession';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../db/maintenance';
import { getAllLocations } from '../../db/queries/locations';
import { getTaxonomyTypes } from '../../db/queries/taxonomy';
import { renderIcon } from '../../constants/locationStyles';
import { SearchablePicker, PickerOption } from '../SearchablePicker';
import { SuggestInput } from '../SuggestInput';
import { colors, spacing, fontSizes } from '../../theme';
import { PrimaryButton } from '../ui/PrimaryButton';
import { AppInput } from '../ui/AppInput';
import { FieldLabel } from '../ui/FieldLabel';
import { FilterChip } from '../ui/FilterChip';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';
import { AdvancedFields } from '../ui/AdvancedFields';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

export default function JobQuickAdd({ onSaved }: Props) {
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

  const jobTypes = useMemo(() => getTaxonomyTypes('job'), []);
  const [type, setType] = useState<string | null>(() => {
    const ts = getTaxonomyTypes('job');
    return ts[0]?.label ?? null;
  });

  const locationOptions = useMemo(
    (): PickerOption[] => getAllLocations().map(l => ({ id: l.id, label: l.name })),
    [],
  );

  // Prior values for the typeahead dropdowns.
  const customerOptions = useMemo(() => getDistinctCustomerNames(), []);
  const carrierOptions = useMemo(() => getDistinctInsuranceCarriers(), []);
  const addressOptions = useMemo(() => getDistinctSiteAddresses(), []);

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
    if (isWriteBlocked()) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError('Job name is required.');
      return;
    }
    if (!user) {
      Alert.alert('Error', 'Not logged in.');
      return;
    }
    setNameError('');

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
    <View style={s.container}>
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

        <View style={s.fieldWrap}>
          <FieldLabel>Site Address</FieldLabel>
          <SuggestInput
            value={siteAddress}
            onChange={setSiteAddress}
            suggestions={addressOptions}
            placeholder="Street address or description"
          />
        </View>

        <View style={s.fieldWrap}>
          <FieldLabel>Site Location</FieldLabel>
          <SearchablePicker
            placeholder="Search locations..."
            options={locationOptions}
            value={siteLocation}
            onSelect={opt => setSiteLocation(prev => prev?.id === opt.id ? null : opt)}
          />
        </View>

        <View style={s.fieldWrap}>
          <FieldLabel>Reference # (external)</FieldLabel>
          <AppInput
            value={referenceNumber}
            onChangeText={setReferenceNumber}
            placeholder="Insurance claim / customer PO #"
            autoCapitalize="characters"
          />
        </View>

        <View style={s.fieldWrap}>
          <FieldLabel>Insurance carrier</FieldLabel>
          <SuggestInput
            value={insuranceCarrier}
            onChange={setInsuranceCarrier}
            suggestions={carrierOptions}
            placeholder="Insurance company"
          />
        </View>

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

      <PrimaryButton
        label="Save & add another"
        onPress={handleSave}
        disabled={locked}
        style={{ marginTop: spacing.md }}
      />
      {locked && <MaintenanceBanner />}
    </View>
  );
}

const s = StyleSheet.create({
  container: { gap: 12 },
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
  inputError: { borderColor: colors.danger },
  errorText: { fontSize: fontSizes.caption, color: colors.danger },
});
