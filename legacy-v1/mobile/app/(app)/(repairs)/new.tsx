import { useState, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Alert } from '../../../src/lib/themedAlert';
import { runInTransaction } from '../../../src/db/tx';
import { createRepair, Repair } from '../../../src/db/queries/repairs';
import { getRepairStatuses, isTerminalStatus } from '../../../src/db/queries/taxonomy';
import { setUnitStatus } from '../../../src/db/queries/equipmentUnits';
import { appendOutbox } from '../../../src/sync/outbox';
import { appendLog } from '../../../src/db/queries/log';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useTableVersion } from '../../../src/hooks/useDataVersion';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { AppInput } from '../../../src/components/ui/AppInput';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { FormScreen } from '../../../src/components/ui/FormScreen';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

const ENTITY_TYPE_LABEL: Record<string, string> = {
  equipment_unit: 'Equipment Unit',
  item: 'Item',
  location: 'Vehicle',
};

export default function NewRepairScreen() {
  const s = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{ entityType: string; entityId: string; entityLabel?: string }>();
  const entityType = params.entityType as Repair['entity_type'];
  const entityId = params.entityId;
  const entityLabel = params.entityLabel ?? null;

  const router = useRouter();
  const canEdit = usePermission('edit_inventory');
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();

  // Status chips: only NON-terminal statuses can be chosen at creation — a new
  // ticket must start open (a terminal status here would leave completed_at null
  // while the unit is driven in_repair, never to return). Completion happens on
  // the detail screen.
  const taxonomyVersion = useTableVersion(['taxonomy_types']);
  const statuses = useMemo(() => getRepairStatuses().filter(st => !isTerminalStatus(st.label)), [taxonomyVersion]);
  const [status, setStatus] = useState<string>(() => statuses[0]?.label ?? 'Open');

  const [notes, setNotes] = useState('');
  const [parts, setParts] = useState('');

  if (!entityType || !entityId) {
    return (
      <>
        <Stack.Screen options={{ title: 'Report Repair', headerShown: true }} />
        <View style={s.center}>
          <EmptyState title="Missing entity" subtitle="No entity was provided to repair." />
        </View>
      </>
    );
  }

  if (!canEdit) {
    return (
      <>
        <Stack.Screen options={{ title: 'Report Repair', headerShown: true }} />
        <View style={s.center}>
          <EmptyState
            title="No permission"
            subtitle="You don't have permission to report repairs."
          />
        </View>
      </>
    );
  }

  function onSave() {
    if (isWriteBlocked()) return;
    if (!canEdit) return;
    if (!entityType || !entityId) return;

    let repair: Repair;
    try {
      // Atomic: create the ticket, auto-drive the unit, and log it all together
      // so a mid-flow failure can't leave a repair without its unit/status side
      // effects (or vice-versa).
      repair = runInTransaction(() => {
        const created = createRepair({
          entity_type: entityType,
          entity_id: entityId,
          entity_label: entityLabel,
          notes: notes.trim() || null,
          parts_needed: parts.trim() || null,
          status,
          created_by: user?.id ?? null,
        });

        // Auto-drive: opening a ticket on an equipment unit sends it to repair.
        if (entityType === 'equipment_unit') {
          const updated = setUnitStatus(entityId, { status: 'in_repair' });
          appendOutbox('UPDATE', 'equipment_units', {
            id: updated.id, item_id: updated.item_id, asset_tag: updated.asset_tag,
            serial_number: updated.serial_number, status: updated.status,
            current_location_id: updated.current_location_id, current_job_id: updated.current_job_id,
            notes: updated.notes, created_at: updated.created_at, updated_at: updated.updated_at,
            // synced_at intentionally omitted
          });
        }

        appendLog({
          user_id: realUser?.id ?? null, team_id: null, action: 'repair_opened',
          entity_type: 'repair', entity_id: created.id,
          from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
          note: entityLabel, metadata: null, device_id: null,
        });

        return created;
      });
    } catch (err) {
      // Nothing was committed — surface the failure and stay on the form.
      Alert.alert(
        'Could not report repair',
        (err as Error)?.message ?? 'The repair could not be saved. Please try again.',
      );
      return;
    }

    // Writes committed — safe to navigate to the new ticket.
    router.replace({ pathname: '/(app)/(repairs)/[id]', params: { id: repair.id } });
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Report Repair', headerShown: true }} />
      <FormScreen contentContainerStyle={s.content}>
          {/* ── Entity (read-only) ──────────────────────────────────────── */}
          <View style={s.card}>
            <Text style={s.entityKind}>{ENTITY_TYPE_LABEL[entityType] ?? entityType}</Text>
            <Text style={s.entityLabel}>{entityLabel ?? '(unnamed)'}</Text>
          </View>

          {locked && <MaintenanceBanner />}

          {/* ── Status ──────────────────────────────────────────────────── */}
          <View style={s.fieldWrap}>
            <FieldLabel>Status</FieldLabel>
            <View style={s.chipRow}>
              {statuses.map(st => (
                <FilterChip
                  key={st.id}
                  label={st.icon ? `${st.icon} ${st.label}` : st.label}
                  active={status === st.label}
                  onPress={() => setStatus(st.label)}
                />
              ))}
            </View>
          </View>

          {/* ── Notes ───────────────────────────────────────────────────── */}
          <View style={s.fieldWrap}>
            <FieldLabel>Notes</FieldLabel>
            <AppInput
              style={s.multiline}
              value={notes}
              onChangeText={setNotes}
              placeholder="What's wrong / what needs doing?"
              multiline
            />
          </View>

          {/* ── Parts needed ────────────────────────────────────────────── */}
          <View style={s.fieldWrap}>
            <FieldLabel>Parts needed</FieldLabel>
            <AppInput
              style={s.multiline}
              value={parts}
              onChangeText={setParts}
              placeholder="Parts required (free text)"
              multiline
            />
          </View>

          <PrimaryButton
            label="Report Repair"
            onPress={onSave}
            disabled={locked}
            style={{ marginTop: 8 }}
          />
      </FormScreen>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: { backgroundColor: t.colors.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: t.colors.borderDetail },
  entityKind: { fontSize: 12, fontWeight: '700', color: t.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  entityLabel: { fontSize: 20, fontWeight: '700', color: t.colors.brand, marginTop: 4 },
  fieldWrap: { gap: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  multiline: { height: 80, paddingTop: 12, textAlignVertical: 'top' },
});
