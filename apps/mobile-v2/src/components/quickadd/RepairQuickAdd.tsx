import { useMemo, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { runInTransaction, useTableVersion } from '@invenpro/core';
import {
  useThemedStyles, FilterChip, FieldLabel, AppInput, FormScreen, type Theme,
} from '@invenpro/ui';
import { createRepair, type Repair } from '../../repos/repairs';
import { getRepairStatuses, isTerminalStatus } from '../../repos/taxonomy';
import { setUnitStatus, searchUnitsByTag } from '../../repos/equipmentUnits';
import { searchItems } from '../../repos/items';
import { getAllActiveUsers, getUserById } from '../../repos/users';
import { getRoleColorMap, roleColor } from '../../repos/roleSettings';
import { getUnitLocations, findOrCreateVehicleByName } from '../../repos/locations';
import { appendLog } from '../../db/queries/log';
import { isWriteBlocked } from '../../db/maintenance';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { SearchablePicker, type PickerOption } from '../SearchablePicker';
import { QuickAddFooter } from './QuickAddFooter';
import { track } from '../../telemetry';
import { validateText } from '../../lib/validation';

// Ported from apps/mobile/src/components/quickadd/RepairQuickAdd.tsx (293 ln,
// Station C4 — the item was mislabeled TODO(wave-D) in Station C3's own
// comments, but per the coordinator's C4 dispatch this was C4 scope all
// along; repairs/ is no longer excluded this wave).
//
// Import mapping applied (docs/REBUILD-PORTING.md):
//   '../../db/queries/repairs' (createRepair, Repair) → '../../repos/repairs'
//     (Station C4 repo port — insert()/update() self-mirror the outbox; no
//     hand-rolled appendOutbox needed for the repairs row itself).
//   '../../db/queries/taxonomy' → '../../repos/taxonomy' (already ported).
//   '../../db/queries/equipmentUnits' (setUnitStatus, searchUnitsByTag) →
//     '../../repos/equipmentUnits'. IMPORTANT DEVIATION: mobile-v2's
//     setUnitStatus already calls equipmentUnitsRepo.update(...) internally
//     (self-mirrors) — the old app's manual appendOutbox('UPDATE',
//     'equipment_units', {...}) call after setUnitStatus is DROPPED here
//     entirely; duplicating it would double-outbox the same write.
//   '../../db/queries/items' (searchItems) → '../../repos/items'.
//   '../../db/queries/users' (getAllActiveUsers, getUserById, roleColor,
//     getRoleColorMap) → split across '../../repos/users' (getAllActiveUsers,
//     getUserById) and '../../repos/roleSettings' (roleColor,
//     getRoleColorMap) — mobile-v2 factored role-color helpers into their own
//     module (see UserQuickAdd.tsx, VehicleQuickAdd's owner picker precedent).
//   '../../db/queries/locations' (getNonShelfLocations,
//     findOrCreateVehicleByName) → '../../repos/locations'; #280 later swapped
//     getNonShelfLocations for getUnitLocations (vehicle picker fix).
//   '../../sync/outbox' (appendOutbox) → DROPPED (see setUnitStatus note
//     above — no direct outbox call remains in this file).
//   ui/FilterChip, ui/FieldLabel, ui/AppInput, ui/FormScreen,
//   useThemedStyles → '@invenpro/ui'.
//   '../../hooks/useDataVersion' (useTableVersion) + '../../db/tx'
//     (runInTransaction) → '@invenpro/core'.
// Straight port otherwise (entity-type chips, target picker w/ inline vehicle
// create, status chips restricted to non-terminal, optional role-colored
// assignee picker, notes/parts_needed free text).
//
// Caller-owned self-log convention (this wave's standing rule): createRepair
// does not self-log — the equipment-unit auto-drive-to-repair write and the
// 'repair_opened' appendLog are wrapped together in one runInTransaction
// alongside it, same discipline as every other quickadd form this wave.

interface Props {
  onSaved: (label: string, createdId?: string) => void;
}

// Same three targets a repair ticket can point at; entity_type 'location' is the
// app's "Vehicle" (mirrors ENTITY_TYPE_LABEL in the old app's (repairs)/new.tsx).
const ENTITY_TYPES: { type: Repair['entity_type']; label: string }[] = [
  { type: 'item', label: 'Item' },
  { type: 'equipment_unit', label: 'Equipment Unit' },
  { type: 'location', label: 'Vehicle' },
];

// Audit a validation rejection — field path + rule name ONLY, never the value.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'quick_add', props: { field, rule } });
}

export default function RepairQuickAdd({ onSaved }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();
  const canManageLocations = usePermission('manage_locations');
  // One-tap "report a repair for THIS thing" (ItemCard, equipment/[id],
  // locations/[id]'s "Report repair" rows) — pre-fills the target instead of
  // dropping the user on the blank chooser. Replaces the old app's dedicated
  // '/(repairs)/new?entityType=&entityId=&entityLabel=' screen, which the
  // Station C4 brief cut in favor of quick-add-only creation; the params
  // travel the same way (URL search params into this screen), just read
  // directly here instead of by a separate route file. Read once at mount —
  // this screen doesn't need to react to a param change mid-session.
  const initialParams = useLocalSearchParams<{ entityType?: string; entityId?: string; entityLabel?: string }>();
  const initialEntityType: Repair['entity_type'] | null =
    initialParams.entityType === 'item' || initialParams.entityType === 'equipment_unit' || initialParams.entityType === 'location'
      ? initialParams.entityType
      : null;
  // Re-read pickers when a pull (or a local write, e.g. inline vehicle create)
  // touches their tables.
  const optionsVersion = useTableVersion(['taxonomy_types', 'users', 'role_settings']);
  const vehiclesVersion = useTableVersion(['locations']);

  // Non-terminal statuses only — a new ticket must start open.
  const statuses = useMemo(() => getRepairStatuses().filter(st => !isTerminalStatus(st.label)), [optionsVersion]);
  const [status, setStatus] = useState<string>(() => statuses[0]?.label ?? 'Open');

  const [entityType, setEntityType] = useState<Repair['entity_type']>(() => initialEntityType ?? 'item');
  const [target, setTarget] = useState<PickerOption | null>(() => (
    initialEntityType && initialParams.entityId
      ? { id: initialParams.entityId, label: initialParams.entityLabel ?? initialParams.entityId }
      : null
  )); // chosen entity
  const [targetError, setTargetError] = useState('');
  const [notes, setNotes] = useState('');
  const [notesError, setNotesError] = useState('');
  const [parts, setParts] = useState('');
  const [partsError, setPartsError] = useState('');
  const [assigneeOpt, setAssigneeOpt] = useState<PickerOption | null>(null);

  const assigneeOptions = useMemo<PickerOption[]>(
    () => getAllActiveUsers().map(u => ({ id: u.id, label: u.name })),
    [optionsVersion],
  );
  const roleColorMap = useMemo(() => getRoleColorMap(), [optionsVersion]);
  const assigneeUser = useMemo(
    () => (assigneeOpt ? getUserById(assigneeOpt.id) : null),
    [assigneeOpt, optionsVersion],
  );

  // Vehicles = unit-location rows tagged 'Vehicle' (#280). Must NOT come from
  // getNonShelfLocations() — that list EXCLUDES units (isUnitLocation), so the
  // old "fall back to all locations when empty" branch here always fired and
  // the picker showed places instead of vehicles. Empty is fine: managers can
  // still type-to-create via onCreate below.
  const vehicleOptions = useMemo<PickerOption[]>(
    () => getUnitLocations('Vehicle').map(l => ({ id: l.id, label: l.name })),
    [vehiclesVersion],
  );

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
      trackReject('repair.target', 'required');
      setTargetError('Choose what to repair.');
      return;
    }
    setTargetError('');

    // Optional free text, bounded + control-char-rejecting, checked BEFORE any
    // local write. Blank stays fine (→ null below, as before).
    const notesResult = validateText(notes, { label: 'Notes' });
    if (!notesResult.ok) {
      trackReject('repair.notes', notesResult.rule);
      setNotesError(notesResult.error);
      return;
    }
    setNotesError('');
    const partsResult = validateText(parts, { label: 'Parts needed' });
    if (!partsResult.ok) {
      trackReject('repair.parts_needed', partsResult.rule);
      setPartsError(partsResult.error);
      return;
    }
    setPartsError('');

    track('action', 'quickadd_save_repair', { screen: 'quick_add' });

    // Definite-assignment: always set inside the synchronous transaction
    // callback below before being read.
    let repair!: Repair;
    // Atomic (#125 discipline): the repair row, the optional equipment-unit
    // auto-drive-to-repair write, and the open-ticket log land together or
    // not at all. createRepair/setUnitStatus both self-mirror to the outbox
    // internally — no hand-rolled appendOutbox here (unlike the old app).
    runInTransaction(() => {
      repair = createRepair({
        entity_type: entityType,
        entity_id: target.id,
        entity_label: target.label,
        notes: notesResult.value || null,
        parts_needed: partsResult.value || null,
        status,
        created_by: user?.id ?? null,
        assignee_id: assigneeOpt?.id ?? null,
      });

      // Auto-drive: opening a ticket on an equipment unit sends it to repair.
      if (entityType === 'equipment_unit') {
        setUnitStatus(target.id, { status: 'in_repair' });
      }

      appendLog({
        user_id: realUser?.id ?? null, team_id: null, action: 'repair_opened',
        entity_type: 'repair', entity_id: repair.id,
        from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
        note: target.label, metadata: null, device_id: null,
      });
    });

    onSaved(target.label, repair.id);
    // Clear for "add another"; keep entity type + status sticky.
    setTarget(null);
    setNotes('');
    setParts('');
  }

  return (
    // Owns its FormScreen (shell passes wrapForm={false}) so the save bar sits
    // in the sticky footer slot and floats above the keyboard (#118). Repair
    // quick-add historically has no Done row (header back exits).
    <FormScreen
      contentContainerStyle={s.content}
      footer={<QuickAddFooter onSave={handleSave} disabled={locked} locked={locked} showDone={false} />}
    >
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
          onChangeText={t => { setNotes(t); if (notesError) setNotesError(''); }}
          placeholder="What's wrong / what needs doing?"
          multiline
        />
        {!!notesError && <Text style={s.errorText}>{notesError}</Text>}
      </View>

      {/* ── Parts needed ────────────────────────────────────────────── */}
      <View style={s.fieldWrap}>
        <FieldLabel>Parts needed</FieldLabel>
        <AppInput
          style={s.multiline}
          value={parts}
          onChangeText={t => { setParts(t); if (partsError) setPartsError(''); }}
          placeholder="Parts required (free text)"
          multiline
        />
        {!!partsError && <Text style={s.errorText}>{partsError}</Text>}
      </View>
    </FormScreen>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // Mirrors the shell's default FormScreen content padding + this form's row gap.
  content: { padding: t.spacing.lg, paddingBottom: 48, gap: 12 },
  fieldWrap: { gap: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  multiline: { height: 80, paddingTop: 12, textAlignVertical: 'top' },
  errorText: { fontSize: t.typography.fontSizes.caption, color: t.colors.danger },
  assigneeName: { fontSize: t.typography.fontSizes.body2, fontWeight: '600' },
});
