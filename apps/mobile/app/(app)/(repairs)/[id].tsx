import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { appendOutbox } from '../../../src/sync/outbox';
import {
  getRepairById, updateRepairFields, updateRepairStatus, Repair,
} from '../../../src/db/queries/repairs';
import { getRepairStatuses, isTerminalStatus, getTypeIcon } from '../../../src/db/queries/taxonomy';
import { setUnitStatus } from '../../../src/db/queries/equipmentUnits';
import { getAllLocations } from '../../../src/db/queries/locations';
import { appendLog } from '../../../src/db/queries/log';
import { colors } from '../../../src/theme';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { AppInput } from '../../../src/components/ui/AppInput';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import ActivityFeed from '../../../src/components/ActivityFeed';

const ENTITY_TYPE_LABEL: Record<Repair['entity_type'], string> = {
  equipment_unit: 'Equipment unit',
  item: 'Item',
  location: 'Vehicle',
};

export default function RepairDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useSession();
  const canEdit = usePermission('edit_inventory');
  const { locked } = useMaintenanceMode();

  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey(k => k + 1), []);

  const repair = useMemo(() => (id ? getRepairById(id) : null), [id, reloadKey]);

  // Editable field buffers (re-seeded whenever the repair reloads)
  const [notes, setNotes] = useState<string>(repair?.notes ?? '');
  const [parts, setParts] = useState<string>(repair?.parts_needed ?? '');
  const [seededFor, setSeededFor] = useState<string>('');
  if (repair && seededFor !== `${repair.id}:${reloadKey}`) {
    setNotes(repair.notes ?? '');
    setParts(repair.parts_needed ?? '');
    setSeededFor(`${repair.id}:${reloadKey}`);
  }

  const statuses = useMemo(() => getRepairStatuses(), []);
  const locationOptions = useMemo<PickerOption[]>(
    () => getAllLocations().map(l => ({ id: l.id, label: l.name })),
    [],
  );

  // Return-location modal state (only used for equipment-unit completion)
  const [returnUnitId, setReturnUnitId] = useState<string | null>(null);
  const [returnLoc, setReturnLoc] = useState<PickerOption | null>(null);

  if (!repair) {
    return (
      <>
        <Stack.Screen options={{ title: 'Repair', headerShown: true }} />
        <View style={s.container}>
          <EmptyState title="Repair not found" />
        </View>
      </>
    );
  }

  const dirty =
    notes !== (repair.notes ?? '') || parts !== (repair.parts_needed ?? '');

  function saveFields() {
    if (!repair || isWriteBlocked()) return;
    updateRepairFields(repair.id, {
      notes: notes.trim() || null,
      parts_needed: parts.trim() || null,
    });
    reload();
  }

  function logStatus(action: string, note: string) {
    if (!repair) return;
    appendLog({
      user_id: user?.id ?? null, team_id: null, action,
      entity_type: 'repair', entity_id: repair.id,
      from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
      note, metadata: null, device_id: null,
    });
  }

  // Mirror an equipment_units status write into the outbox (synced_at omitted),
  // identical to (equipment)/[id].tsx doRepairOut/doRepairIn.
  function outboxUnit(updated: ReturnType<typeof setUnitStatus>) {
    appendOutbox('UPDATE', 'equipment_units', {
      id: updated.id, item_id: updated.item_id, asset_tag: updated.asset_tag,
      serial_number: updated.serial_number, status: updated.status,
      current_location_id: updated.current_location_id, current_job_id: updated.current_job_id,
      notes: updated.notes, created_at: updated.created_at, updated_at: updated.updated_at,
    });
  }

  function pickStatus(label: string) {
    if (!repair || isWriteBlocked()) return;
    if (label === repair.status) return;
    const terminal = isTerminalStatus(label);
    const wasCompleted = repair.completed_at != null;
    updateRepairStatus(repair.id, label, terminal);
    logStatus(
      terminal ? 'repair_completed' : 'repair_status_changed',
      `Status → ${label}`,
    );
    if (terminal && repair.entity_type === 'equipment_unit') {
      // Completing a ticket on an equipment unit returns it to service.
      setReturnLoc(null);
      setReturnUnitId(repair.entity_id);
    } else if (!terminal && wasCompleted && repair.entity_type === 'equipment_unit') {
      // Reopening a completed repair drives the unit back to in_repair (symmetric
      // with create-time auto-drive) so it isn't "available" with an open ticket.
      outboxUnit(setUnitStatus(repair.entity_id, { status: 'in_repair', notes: null }));
    }
    reload();
  }

  // Return the just-completed unit to service. Location is optional (Skip → null)
  // so a completed ticket NEVER leaves a unit stranded in_repair.
  function confirmReturn(loc: PickerOption | null) {
    if (!repair || !returnUnitId) return;
    if (isWriteBlocked()) { setReturnUnitId(null); setReturnLoc(null); return; }
    const updated = setUnitStatus(returnUnitId, {
      status: 'available', current_location_id: loc?.id ?? null, notes: null,
    });
    outboxUnit(updated);
    appendLog({
      user_id: user?.id ?? null, team_id: null, action: 'repair_in',
      entity_type: 'item', entity_id: updated.item_id,
      from_location_id: null, to_location_id: loc?.id ?? null, quantity: null, unit: null, job_id: null,
      note: 'unit ' + updated.asset_tag + ' returned from repair',
      metadata: null, device_id: null,
    });
    setReturnUnitId(null);
    setReturnLoc(null);
    reload();
  }

  // Best-effort link back to the source entity (equipment links by unit id are
  // not resolvable to the item-keyed equipment screen, so only item/location).
  function openEntity() {
    if (!repair) return;
    if (repair.entity_type === 'item') {
      router.push({ pathname: '/(app)/(inventory)/[id]', params: { id: repair.entity_id } });
    } else if (repair.entity_type === 'location') {
      router.push({ pathname: '/(app)/(locations)/[id]', params: { id: repair.entity_id } });
    }
  }

  const linkable = repair.entity_type === 'item' || repair.entity_type === 'location';
  const statusIcon = getTypeIcon('repair_status', repair.status);

  return (
    <>
      <Stack.Screen options={{ title: 'Repair', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity disabled={!linkable} onPress={openEntity}>
            <Text style={[s.entityLabel, linkable && s.entityLink]}>
              {repair.entity_label ?? '(unlabeled)'}
            </Text>
          </TouchableOpacity>
          <Text style={s.entityType}>{ENTITY_TYPE_LABEL[repair.entity_type]}</Text>
          <Text style={s.currentStatus}>
            {statusIcon ? `${statusIcon} ` : ''}{repair.status}
          </Text>
          {repair.completed_at && (
            <Text style={s.completedAt}>
              Completed {new Date(repair.completed_at).toLocaleString()}
            </Text>
          )}
        </View>

        {/* Status picker */}
        <FieldLabel>Status</FieldLabel>
        <View style={s.statusRow}>
          {statuses.map(st => (
            <FilterChip
              key={st.id}
              label={st.icon ? `${st.icon} ${st.label}` : st.label}
              active={repair.status === st.label}
              onPress={() => { if (canEdit) pickStatus(st.label); }}
            />
          ))}
        </View>
        {!canEdit && (
          <Text style={s.readonlyNote}>You do not have permission to edit this repair.</Text>
        )}

        {/* Editable fields */}
        <FieldLabel style={{ marginTop: 16 }}>Notes</FieldLabel>
        <AppInput
          value={notes}
          onChangeText={setNotes}
          placeholder="What is wrong / work done…"
          multiline
          editable={canEdit}
          style={s.multiline}
        />

        <FieldLabel style={{ marginTop: 12 }}>Parts needed</FieldLabel>
        <AppInput
          value={parts}
          onChangeText={setParts}
          placeholder="Parts required…"
          multiline
          editable={canEdit}
          style={s.multiline}
        />

        {canEdit && dirty && (
          <PrimaryButton
            label="Save changes"
            onPress={saveFields}
            disabled={locked}
            style={{ marginTop: 12 }}
          />
        )}

        {/* Media */}
        <Text style={s.sectionTitle}>Photos</Text>
        <MediaGallery entityType="repair" entityId={repair.id} canUpload={canEdit} />

        {/* History */}
        <Text style={s.sectionTitle}>History</Text>
        <ActivityFeed entityType="repair" entityId={repair.id} />
      </ScrollView>

      {/* Return-from-repair location picker (equipment completion) */}
      <ModalSheet visible={returnUnitId !== null} onClose={() => confirmReturn(returnLoc)}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <Text style={s.modalTitle}>Return to service</Text>
          <Text style={s.modalSub}>
            This repair is complete, so the unit goes back to available. Optionally
            choose where it returns.
          </Text>
          <FieldLabel style={{ marginTop: 12 }}>Return to Location (optional)</FieldLabel>
          <SearchablePicker
            placeholder="Search location…"
            options={locationOptions}
            value={returnLoc}
            onSelect={(opt) => setReturnLoc(prev => (prev?.id === opt.id ? null : opt))}
          />
          <View style={[s.row, { marginTop: 16 }]}>
            <TouchableOpacity
              style={[s.btn, s.btnGhost]}
              onPress={() => confirmReturn(null)}
            >
              <Text style={s.btnGhostText}>No location</Text>
            </TouchableOpacity>
            <PrimaryButton
              label="Confirm Return"
              onPress={() => confirmReturn(returnLoc)}
              disabled={locked}
              style={{ flex: 1 }}
            />
          </View>
        </ScrollView>
      </ModalSheet>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingBottom: 48 },
  header: {
    backgroundColor: colors.surface, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: colors.border, marginBottom: 16, gap: 2,
  },
  entityLabel: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  entityLink: { color: colors.primary },
  entityType: { fontSize: 13, color: colors.textSecondary },
  currentStatus: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginTop: 4 },
  completedAt: { fontSize: 12, color: colors.success, fontWeight: '600', marginTop: 2 },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  readonlyNote: { fontSize: 12, color: colors.textMuted, marginTop: 8 },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  sectionTitle: {
    fontSize: 12, fontWeight: '700', color: colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 1, marginTop: 24, marginBottom: 8,
  },
  modalTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary },
  modalSub: { fontSize: 13, color: colors.textSecondary, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  btn: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center' },
  btnGhost: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  btnGhostText: { color: colors.textSecondary, fontWeight: '600' },
});
