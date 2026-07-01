import { useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { createRepair, Repair } from '../../db/queries/repairs';
import { getRepairStatuses, isTerminalStatus } from '../../db/queries/taxonomy';
import { setUnitStatus, searchUnitsByTag } from '../../db/queries/equipmentUnits';
import { searchItems } from '../../db/queries/items';
import { getAllActiveUsers, getUserById, roleColor, getRoleColorMap } from '../../db/queries/users';
import { getAllLocations, findOrCreateVehicleByName } from '../../db/queries/locations';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { isWriteBlocked } from '../../db/maintenance';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { SearchablePicker } from '../SearchablePicker';
import type { PickerOption } from '../SearchablePicker';
import { FilterChip } from '../ui/FilterChip';
import { FieldLabel } from '../ui/FieldLabel';
import { AppInput } from '../ui/AppInput';
import { PrimaryButton } from '../ui/PrimaryButton';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';
import { colors, spacing, fontSizes } from '../../theme';

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

// Same three targets a repair ticket can point at; entity_type 'location' is the
// app's "Vehicle" (mirrors ENTITY_TYPE_LABEL in (repairs)/new.tsx).
const ENTITY_TYPES: { type: Repair['entity_type']; label: string }[] = [
  { type: 'item', label: 'Item' },
  { type: 'equipment_unit', label: 'Equipment Unit' },
  { type: 'location', label: 'Vehicle' },
];

export default function RepairQuickAdd({ onSaved }: Props) {
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const canManageLocations = usePermission('manage_locations');
  // Bumped after an inline vehicle create so the options list picks up the new row.
  const [vehiclesRefresh, setVehiclesRefresh] = useState(0);

  // Non-terminal statuses only — a new ticket must start open (see (repairs)/new.tsx).
  const statuses = useMemo(() => getRepairStatuses().filter(st => !isTerminalStatus(st.label)), []);
  const [status, setStatus] = useState<string>(() => statuses[0]?.label ?? 'Open');

  const [entityType, setEntityType] = useState<Repair['entity_type']>('item');
  const [target, setTarget] = useState<PickerOption | null>(null); // chosen entity
  const [targetError, setTargetError] = useState('');
  const [notes, setNotes] = useState('');
  const [parts, setParts] = useState('');
  const [assigneeOpt, setAssigneeOpt] = useState<PickerOption | null>(null);

  const assigneeOptions = useMemo<PickerOption[]>(
    () => getAllActiveUsers().map(u => ({ id: u.id, label: u.name })),
    [],
  );
  const roleColorMap = useMemo(() => getRoleColorMap(), []);
  const assigneeUser = useMemo(
    () => (assigneeOpt ? getUserById(assigneeOpt.id) : null),
    [assigneeOpt],
  );

  // Vehicles = location rows tagged as 'Vehicle' (fall back to all locations so the
  // picker is never empty when no type has been set yet).
  const vehicleOptions = useMemo<PickerOption[]>(() => {
    const all = getAllLocations();
    const vehicles = all.filter(l => (l.type ?? '').toLowerCase() === 'vehicle');
    return (vehicles.length ? vehicles : all).map(l => ({ id: l.id, label: l.name }));
  }, [vehiclesRefresh]);

  // DB-backed search for the large sets (catalog items, units by exact asset tag).
  const entitySearch = useMemo<((q: string) => PickerOption[]) | undefined>(() => {
    if (entityType === 'item') {
      return (q: string) =>
        searchItems(q, 12).map(i => ({ id: i.id, label: i.name, sublabel: i.sku ?? undefined }));
    }
    if (entityType === 'equipment_unit') {
      // Typeahead over asset tags (ranked, prefix-first) so the user sees existing
      // units as they type rather than needing the exact full tag.
      return (q: string) =>
        searchUnitsByTag(q, 12).map(u => ({ id: u.id, label: u.asset_tag, sublabel: u.serial_number ?? undefined }));
    }
    return undefined; // vehicles use the static options list below
  }, [entityType]);

  function pickType(t: Repair['entity_type']) {
    setEntityType(t);
    setTarget(null); // entity ids aren't shared across types
    setTargetError('');
  }

  function handleSave() {
    if (isWriteBlocked()) return;
    if (!target) {
      setTargetError('Choose what to repair.');
      return;
    }
    setTargetError('');

    const repair = createRepair({
      entity_type: entityType,
      entity_id: target.id,
      entity_label: target.label,
      notes: notes.trim() || null,
      parts_needed: parts.trim() || null,
      status,
      created_by: user?.id ?? null,
      assignee_id: assigneeOpt?.id ?? null,
    });

    // Auto-drive: opening a ticket on an equipment unit sends it to repair.
    if (entityType === 'equipment_unit') {
      const updated = setUnitStatus(target.id, { status: 'in_repair' });
      appendOutbox('UPDATE', 'equipment_units', {
        id: updated.id, item_id: updated.item_id, asset_tag: updated.asset_tag,
        serial_number: updated.serial_number, status: updated.status,
        current_location_id: updated.current_location_id, current_job_id: updated.current_job_id,
        notes: updated.notes, created_at: updated.created_at, updated_at: updated.updated_at,
        // synced_at intentionally omitted
      });
    }

    appendLog({
      user_id: user?.id ?? null, team_id: null, action: 'repair_opened',
      entity_type: 'repair', entity_id: repair.id,
      from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
      note: target.label, metadata: null, device_id: null,
    });

    onSaved(target.label, repair.id);
    // Clear for "add another"; keep entity type + status sticky.
    setTarget(null);
    setNotes('');
    setParts('');
  }

  return (
    <View style={s.container}>
      {/* ── Target type ─────────────────────────────────────────────── */}
      <View style={s.fieldWrap}>
        <FieldLabel>What needs repair?</FieldLabel>
        <View style={s.chipRow}>
          {ENTITY_TYPES.map(et => (
            <FilterChip
              key={et.type}
              label={et.label}
              active={entityType === et.type}
              onPress={() => pickType(et.type)}
            />
          ))}
        </View>
      </View>

      {/* ── Target entity ───────────────────────────────────────────── */}
      <View style={s.fieldWrap}>
        <FieldLabel>
          {entityType === 'equipment_unit' ? 'Asset tag' : entityType === 'location' ? 'Vehicle' : 'Item'}
        </FieldLabel>
        <SearchablePicker
          placeholder={
            entityType === 'equipment_unit'
              ? 'Search asset tag…'
              : entityType === 'location'
                ? 'Search vehicles…'
                : 'Search items…'
          }
          options={entityType === 'location' ? vehicleOptions : undefined}
          searchFn={entitySearch}
          value={target}
          onSelect={opt => { setTarget(prev => (prev?.id === opt.id ? null : opt)); if (targetError) setTargetError(''); }}
          onCreate={
            entityType === 'location' && canManageLocations
              ? (name) => {
                  const id = findOrCreateVehicleByName(name);
                  if (!id) return;
                  setTarget({ id, label: name.trim() });
                  setVehiclesRefresh(n => n + 1);
                  if (targetError) setTargetError('');
                }
              : undefined
          }
        />
        {!!targetError && <Text style={s.errorText}>{targetError}</Text>}
      </View>

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

      {/* ── Assignee ────────────────────────────────────────────────── */}
      <View style={s.fieldWrap}>
        <FieldLabel>Assignee (optional)</FieldLabel>
        {assigneeOpt && (
          <Text style={[s.assigneeName, { color: roleColor(assigneeUser?.role ?? '', roleColorMap) }]}>
            {assigneeOpt.label}
          </Text>
        )}
        <SearchablePicker
          placeholder="Search users…"
          options={assigneeOptions}
          value={assigneeOpt}
          onSelect={opt => setAssigneeOpt(prev => (prev?.id === opt.id ? null : opt))}
        />
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
  fieldWrap: { gap: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  multiline: { height: 80, paddingTop: 12, textAlignVertical: 'top' },
  errorText: { fontSize: fontSizes.caption, color: colors.danger },
  assigneeName: { fontSize: fontSizes.body2, fontWeight: '600' },
});
