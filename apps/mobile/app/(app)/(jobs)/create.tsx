import { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { upsertJob, Job } from '../../../src/db/queries/jobs';
import { appendLog } from '../../../src/db/queries/log';
import { appendOutbox } from '../../../src/sync/outbox';
import { getAllLocations } from '../../../src/db/queries/locations';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { generateUUID } from '../../../src/utils/uuid';
import { colors } from '../../../src/theme';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import { AdvancedFields } from '../../../src/components/ui/AdvancedFields';

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

  const locationOptions = useMemo((): PickerOption[] => {
    return getAllLocations().map(l => ({ id: l.id, label: l.name }));
  }, []);

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

          <AdvancedFields>
            <View style={s.fieldWrap}>
              <FieldLabel>Customer Name</FieldLabel>
              <AppInput
                value={customerName}
                onChangeText={setCustomerName}
                placeholder="Customer or company name"
              />
            </View>

            <View style={s.fieldWrap}>
              <FieldLabel>Site Address</FieldLabel>
              <AppInput
                value={siteAddress}
                onChangeText={setSiteAddress}
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
  textArea: { height: 100, paddingTop: 12, paddingBottom: 12 },

  row: { flexDirection: 'row', gap: 12, marginTop: 8 },
  btnGhost: {
    borderRadius: 12, paddingVertical: 13, alignItems: 'center',
    backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.textDisabled,
  },
  btnGhostText: { color: '#475569', fontWeight: '600', fontSize: 16 },
});
