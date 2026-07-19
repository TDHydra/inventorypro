import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet,
} from 'react-native';
import { Stack, useRouter, useLocalSearchParams } from 'expo-router';
import { Alert } from '../../../src/lib/themedAlert';
import { runInTransaction } from '../../../src/db/tx';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { useTableVersion } from '../../../src/hooks/useDataVersion';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { appendOutbox } from '../../../src/sync/outbox';
import {
  getRepairById, updateRepairFields, updateRepairStatus, addRepairPart, getRepairParts, Repair, RepairPart,
} from '../../../src/db/queries/repairs';
import { getRepairStatusesWithFallback, isTerminalStatus, getTypeIcon } from '../../../src/db/queries/taxonomy';
import { setUnitStatus } from '../../../src/db/queries/equipmentUnits';
import { getAllLocations, resolveLocationShelfSelection } from '../../../src/db/queries/locations';
import { getAllActiveUsers, getUserById, roleColor, getRoleColorMap } from '../../../src/db/queries/users';
import { searchItems, getItemById, adjustStock } from '../../../src/db/queries/items';
import { appendLog } from '../../../src/db/queries/log';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import { useTheme } from '../../../src/hooks/useTheme';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { AppInput } from '../../../src/components/ui/AppInput';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { FormScreen } from '../../../src/components/ui/FormScreen';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { QuantityStepper } from '../../../src/components/ui/QuantityStepper';
import { DateField } from '../../../src/components/ui/DateField';
import { toIsoDateString } from '../../../src/components/ui/dateFieldLogic';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { LocationShelfPicker } from '../../../src/components/pickers';
import ActivityFeed from '../../../src/components/ActivityFeed';
import { track } from '../../../src/telemetry';
import { MAX_QUANTITY, validateText } from '../../../src/lib/validation';

// Audit a validation rejection — field path + rule name ONLY, never the value.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'repair_detail', props: { field, rule } });
}

const ENTITY_TYPE_LABEL: Record<Repair['entity_type'], string> = {
  equipment_unit: 'Equipment unit',
  item: 'Item',
  location: 'Vehicle',
};

// Mirrors (admin)/users.tsx's expiry-date helpers for the repair due-date chips.
function isoFromNowDays(days: number): string {
  return new Date(Date.now() + days * 86400000).toISOString();
}
function formatDate(iso: string | null): string {
  if (!iso) return 'No due date';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Local-end-of-day convention: DateField's manual entry only yields a bare
// 'YYYY-MM-DD' (date, no time), while the +Nd chips above write full ISO
// instants via isoFromNowDays. `new Date('YYYY-MM-DD')` parses as UTC
// midnight, which is already in the past for any timezone behind UTC —
// so a repair "due today" would read as Overdue the instant it's saved.
// Anchoring manual entries to 23:59:59 LOCAL time keeps them consistent
// with the chips (full ISO instants) and due today stays not-overdue
// until the end of the user's actual day.
function localEndOfDayIso(dateOnly: string): string {
  const [y, m, d] = dateOnly.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59).toISOString();
}

export default function RepairDetailScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { user } = useSession();
  const canEdit = usePermission('edit_inventory');
  const canViewFinancial = usePermission('view_financial_data');
  // "Use parts" emits an ADJUST to stock_by_location, which the server authorizes
  // on checkin_inventory || checkout_inventory (see syncPolicy requiredOperationPerm's
  // handling of stock_by_location adjustments in sync.ts) — not edit_inventory. An
  // override combo with edit_inventory but neither checkin/checkout would otherwise
  // strand the outbox entry as a permanent conflict. Mirrors the same gate applied to
  // the quick-add stock sheet (QuickAddScreenShell's canAdjustStock).
  const canAdjustStock = usePermission('checkin_inventory') || usePermission('checkout_inventory');
  const canUseParts = canEdit && canAdjustStock;
  const { locked } = useMaintenanceMode();

  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey(k => k + 1), []);
  // Synced repair changes re-read via the table version; reloadKey stays the
  // LOCAL own-write counter (it alone drives the edit-buffer reseed below).
  const version = useTableVersion(['repairs', 'repair_parts']);

  const repair = useMemo(() => (id ? getRepairById(id) : null), [id, reloadKey, version]);
  const repairParts = useMemo<RepairPart[]>(
    () => (repair ? getRepairParts(repair.id) : []),
    [repair, reloadKey, version],
  );

  // Editable field buffers (re-seeded whenever the repair reloads)
  const [notes, setNotes] = useState<string>(repair?.notes ?? '');
  const [parts, setParts] = useState<string>(repair?.parts_needed ?? '');
  const [assigneeOpt, setAssigneeOpt] = useState<PickerOption | null>(null);
  const [costText, setCostText] = useState<string>('');
  const [dueAt, setDueAt] = useState<string | null>(null);
  const [seededFor, setSeededFor] = useState<string>('');
  if (repair && seededFor !== `${repair.id}:${reloadKey}`) {
    setNotes(repair.notes ?? '');
    setParts(repair.parts_needed ?? '');
    setCostText(repair.cost != null ? String(repair.cost) : '');
    setDueAt(repair.due_at ?? null);
    if (repair.assignee_id) {
      const assignee = getUserById(repair.assignee_id);
      setAssigneeOpt({ id: repair.assignee_id, label: assignee?.name ?? '(unknown user)' });
    } else {
      setAssigneeOpt(null);
    }
    setSeededFor(`${repair.id}:${reloadKey}`);
  }

  // Option lists re-read when their source tables change (pull or local write).
  const optionsVersion = useTableVersion(['taxonomy_types', 'locations', 'users', 'role_settings']);
  const statuses = useMemo(() => getRepairStatusesWithFallback(), [optionsVersion]);
  const locationOptions = useMemo<PickerOption[]>(
    () => getAllLocations().map(l => ({ id: l.id, label: l.name })),
    [optionsVersion],
  );
  const assigneeOptions = useMemo<PickerOption[]>(
    () => getAllActiveUsers().map(u => ({ id: u.id, label: u.name })),
    [optionsVersion],
  );
  const roleColorMap = useMemo(() => getRoleColorMap(), [optionsVersion]);
  const assigneeUser = useMemo(
    () => (assigneeOpt ? getUserById(assigneeOpt.id) : null),
    [assigneeOpt, optionsVersion],
  );

  // Return-location modal state (only used for equipment-unit completion)
  const [returnUnitId, setReturnUnitId] = useState<string | null>(null);
  const [returnLoc, setReturnLoc] = useState<PickerOption | null>(null);
  const [returnShelf, setReturnShelf] = useState<PickerOption | null>(null);

  // "Use parts" modal state (consume inventory against this repair)
  const [showUseParts, setShowUseParts] = useState(false);
  const [partItem, setPartItem] = useState<PickerOption | null>(null);
  const [partQty, setPartQty] = useState(0);
  const [partLocation, setPartLocation] = useState<PickerOption | null>(null);
  const [partShelf, setPartShelf] = useState<PickerOption | null>(null);
  const [partError, setPartError] = useState('');
  const partItemSearch = useMemo(
    () => (q: string): PickerOption[] =>
      searchItems(q, 12).map(i => ({ id: i.id, label: i.name, sublabel: i.sku ?? i.unit })),
    [],
  );

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

  // costText only ever changes when the field is rendered (gated by
  // canViewFinancial below), so this can't smuggle an edit through while hidden.
  // NaN (mid-edit garbage) always compares unequal, which correctly surfaces
  // Save so saveFields' validation can reject it with a clear message.
  const parsedCost = costText.trim() === '' ? null : parseFloat(costText);
  const costDirty = parsedCost !== (repair.cost ?? null);
  const dirty =
    notes !== (repair.notes ?? '') ||
    parts !== (repair.parts_needed ?? '') ||
    (assigneeOpt?.id ?? null) !== (repair.assignee_id ?? null) ||
    costDirty ||
    (dueAt ?? null) !== (repair.due_at ?? null);

  const terminal = repair.completed_at != null || isTerminalStatus(repair.status);
  const isOverdue = !!repair.due_at && !terminal && new Date(repair.due_at).getTime() < Date.now();

  function saveFields() {
    if (!repair || isWriteBlocked()) return;
    let costValue: number | null = null;
    if (costText.trim() !== '') {
      const parsed = parseFloat(costText);
      // > MAX_QUANTITY also catches Infinity ('1e999'), which the old NaN
      // check let through.
      if (Number.isNaN(parsed) || parsed < 0 || parsed > MAX_QUANTITY) {
        trackReject('repair.cost', Number.isNaN(parsed) ? 'nan' : parsed < 0 ? 'negative' : 'max');
        Alert.alert('Invalid cost', 'Enter a valid, non-negative cost.');
        return;
      }
      costValue = parsed;
    }
    // Bounded, control-char-free free text, checked BEFORE any local write.
    const notesResult = validateText(notes, { label: 'Notes' });
    if (!notesResult.ok) { trackReject('repair.notes', notesResult.rule); Alert.alert('Check notes', notesResult.error); return; }
    const partsResult = validateText(parts, { label: 'Parts needed' });
    if (!partsResult.ok) { trackReject('repair.parts_needed', partsResult.rule); Alert.alert('Check parts needed', partsResult.error); return; }
    // updateRepairFields already queues its own outbox UPDATE for 'repairs'
    // (synced_at stripped), so the edit syncs. Wrap in a transaction + guard so
    // a failed write can't false-succeed (clear dirty / refresh the form).
    try {
      runInTransaction(() => {
        updateRepairFields(repair.id, {
          notes: notesResult.value || null,
          parts_needed: partsResult.value || null,
          assignee_id: assigneeOpt?.id ?? null,
          cost: costValue,
          due_at: dueAt ?? null,
        });
        appendLog({
          user_id: user?.id ?? null, team_id: null, action: 'repair_updated',
          entity_type: 'repair', entity_id: repair.id,
          from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
          note: null, metadata: null, device_id: null,
        });
      });
    } catch (err) {
      Alert.alert(
        'Could not save changes',
        (err as Error)?.message ?? 'The repair edit could not be saved. Please try again.',
      );
      return;
    }
    reload();
  }

  // "Use parts" — deduct stock, record the repair_parts row, and log the
  // consumption in one atomic transaction (mirrors MoveStockModal's pattern).
  function openUseParts() {
    setPartItem(null);
    setPartQty(0);
    setPartLocation(null);
    setPartShelf(null);
    setPartError('');
    setShowUseParts(true);
  }

  function pickPartItem(opt: PickerOption) {
    setPartItem(prev => (prev?.id === opt.id ? null : opt));
    setPartError('');
    // Changing the item re-defaults the location below, so drop any stale shelf.
    setPartShelf(null);
    // Preselect the item's home location as a convenience default — the user can
    // still override it via the location picker below.
    const full = getItemById(opt.id);
    if (full?.home_location_id) {
      const loc = locationOptions.find(l => l.id === full.home_location_id);
      if (loc) setPartLocation(loc);
    }
  }

  function confirmUseParts() {
    if (!repair || isWriteBlocked() || !canUseParts) return;
    if (!partItem) {
      trackReject('repair_part.item', 'required');
      setPartError('Choose an item.');
      return;
    }
    if (!partLocation) {
      trackReject('repair_part.location', 'required');
      setPartError('Choose a location.');
      return;
    }
    // QuantityStepper already clamps to [0, MAX_QUANTITY] live, so only the
    // ">0" floor (same copy as the old parseStockQuantity('delta') check) can
    // actually be hit here — kept as a real guard rather than trusting the
    // stepper, same as every other field on this screen re-validates before
    // the transaction opens.
    if (partQty <= 0) {
      trackReject('repair_part.qty', 'min');
      setPartError('Quantity must be greater than 0.');
      return;
    }
    const qty = partQty;
    // Resolve the (location, shelf) pair into the id stock is deducted from — a
    // typed-in shelf is find-or-created here. partLocation is non-null (checked
    // above), so ok:true carries a non-null id.
    const locRes = resolveLocationShelfSelection(partLocation, partShelf);
    if (!locRes.ok) {
      trackReject('repair_part.shelf', 'create_failed');
      setPartError(`Could not create shelf "${locRes.shelfLabel}". Please re-pick or re-enter it.`);
      return;
    }
    const stockLocId = locRes.id as string;
    setPartError('');
    const full = getItemById(partItem.id);
    const unit = full?.unit ?? 'each';
    const now = new Date().toISOString();
    try {
      runInTransaction(() => {
        // Deduct stock (server-side GREATEST(0,…) — and adjustStock's own
        // MAX(0,…) locally — guard against going negative; only qty>0 is
        // validated here).
        adjustStock(partItem.id, stockLocId, -qty);
        appendOutbox('ADJUST', 'stock_by_location', {
          item_id: partItem.id, location_id: stockLocId, delta: -qty, updated_at: now,
        });
        addRepairPart(repair.id, partItem.id, qty, unit, user?.id ?? null);
        appendLog({
          user_id: user?.id ?? null, team_id: null, action: 'consumed',
          entity_type: 'item', entity_id: partItem.id,
          from_location_id: stockLocId, to_location_id: null, quantity: qty, unit, job_id: null,
          note: `Used on repair${repair.entity_label ? ' — ' + repair.entity_label : ''}`,
          metadata: null, device_id: null,
        });
      });
    } catch (err) {
      Alert.alert(
        'Could not use parts',
        (err as Error)?.message ?? 'The parts could not be recorded. Please try again.',
      );
      return;
    }
    setShowUseParts(false);
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
    // Atomic: status write + log + any reopen auto-drive land together so a
    // mid-flow failure can't leave the repair status and the unit out of sync.
    try {
      runInTransaction(() => {
        updateRepairStatus(repair.id, label, terminal);
        logStatus(
          terminal ? 'repair_completed' : 'repair_status_changed',
          `Status → ${label}`,
        );
        if (!terminal && wasCompleted && repair.entity_type === 'equipment_unit') {
          // Reopening a completed repair drives the unit back to in_repair (symmetric
          // with create-time auto-drive) so it isn't "available" with an open ticket.
          outboxUnit(setUnitStatus(repair.entity_id, { status: 'in_repair', notes: null }));
        }
      });
    } catch (err) {
      Alert.alert(
        'Could not update status',
        (err as Error)?.message ?? 'The repair status could not be saved. Please try again.',
      );
      return;
    }
    if (terminal && repair.entity_type === 'equipment_unit') {
      // Completing a ticket on an equipment unit returns it to service — prompt
      // for the return location now that the status write has committed.
      setReturnLoc(null);
      setReturnShelf(null);
      setReturnUnitId(repair.entity_id);
    }
    reload();
  }

  // Return the just-completed unit to service. Location is optional (Skip → null)
  // so a completed ticket NEVER leaves a unit stranded in_repair.
  function confirmReturn(loc: PickerOption | null) {
    if (!repair || !returnUnitId) return;
    if (isWriteBlocked()) { setReturnUnitId(null); setReturnLoc(null); setReturnShelf(null); return; }
    // Location is optional here; when one is picked, resolve its (location, shelf)
    // pair into a single id — a typed-in shelf is find-or-created. A null location
    // resolves to { ok: true, id: null } (shelf ignored), preserving Skip → null.
    const locRes = resolveLocationShelfSelection(loc, returnShelf);
    if (!locRes.ok) {
      Alert.alert('Could not create shelf', `Could not create shelf "${locRes.shelfLabel}". Please re-pick or re-enter it.`);
      return;
    }
    const returnLocId = locRes.id;
    // Atomic: drive the unit back to available, queue its outbox UPDATE, and log
    // the return together so a failure can't leave the unit half-returned.
    try {
      runInTransaction(() => {
        const updated = setUnitStatus(returnUnitId, {
          status: 'available', current_location_id: returnLocId, notes: null,
        });
        outboxUnit(updated);
        appendLog({
          user_id: user?.id ?? null, team_id: null, action: 'repair_in',
          entity_type: 'item', entity_id: updated.item_id,
          from_location_id: null, to_location_id: returnLocId, quantity: null, unit: null, job_id: null,
          note: 'unit ' + updated.asset_tag + ' returned from repair',
          metadata: null, device_id: null,
        });
      });
    } catch (err) {
      // Keep the modal open so the user can retry returning the unit.
      Alert.alert(
        'Could not return unit',
        (err as Error)?.message ?? 'The unit could not be returned to service. Please try again.',
      );
      return;
    }
    setReturnUnitId(null);
    setReturnLoc(null);
    setReturnShelf(null);
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
      <FormScreen contentContainerStyle={s.content}>
        {/* Header */}
        <View style={s.header}>
          <TouchableOpacity disabled={!linkable} onPress={openEntity}>
            <Text style={[s.entityLabel, linkable && s.entityLink]}>
              {repair.entity_label ?? '(unlabeled)'}
            </Text>
          </TouchableOpacity>
          <Text style={s.entityType}>{ENTITY_TYPE_LABEL[repair.entity_type]}</Text>
          <View style={s.statusLine}>
            <Text style={s.currentStatus}>
              {statusIcon ? `${statusIcon} ` : ''}{repair.status}
            </Text>
            {isOverdue && (
              <View style={s.overdueBadge}>
                <Text style={s.overdueBadgeText}>Overdue</Text>
              </View>
            )}
          </View>
          {assigneeOpt && (
            <Text style={[s.assigneeLine, { color: roleColor(assigneeUser?.role ?? '', roleColorMap) }]}>
              Assigned to {assigneeOpt.label}
            </Text>
          )}
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

        {/* Assignee */}
        <FieldLabel style={{ marginTop: 12 }}>Assignee</FieldLabel>
        {canEdit ? (
          <SearchablePicker
            placeholder="Search users…"
            options={assigneeOptions}
            value={assigneeOpt}
            onSelect={(opt) => setAssigneeOpt(prev => (prev?.id === opt.id ? null : opt))}
          />
        ) : (
          <Text style={s.readonlyValue}>{assigneeOpt?.label ?? 'Unassigned'}</Text>
        )}

        {/* Cost — visible only to users with view_financial_data; editing still
            gated by the normal repair edit permission (canEdit). */}
        {canViewFinancial && (
          <>
            <FieldLabel style={{ marginTop: 12 }}>Cost</FieldLabel>
            {canEdit ? (
              <AppInput
                value={costText}
                onChangeText={setCostText}
                placeholder="0.00"
                keyboardType="numeric"
              />
            ) : (
              <Text style={s.readonlyValue}>
                {repair.cost != null ? `$${repair.cost.toFixed(2)}` : 'No cost recorded'}
              </Text>
            )}
          </>
        )}

        {/* Due date (SLA target) — the +Nd chips remain the quick path; DateField
            (quickPicks off, its Today/Yesterday chips don't fit a forward-looking
            due date) adds manual entry, which this field never had before. */}
        {canEdit ? (
          <View style={{ marginTop: 12 }}>
            <DateField
              label="Due date"
              // Extract the LOCAL calendar date via getters (toIsoDateString),
              // not by slicing the UTC ISO string: dueAt is stored as local
              // end-of-day (see localEndOfDayIso above), whose UTC-instant
              // date portion can be a day off from the local date in either
              // direction depending on timezone. This is the inverse of
              // localEndOfDayIso and round-trips stably when untouched.
              value={dueAt ? toIsoDateString(new Date(dueAt)) : ''}
              onChange={(iso) => setDueAt(iso ? localEndOfDayIso(iso) : null)}
              quickPicks={false}
              hint={isOverdue ? 'Overdue' : undefined}
            />
            <View style={s.chipWrap}>
              {[1, 3, 7, 14].map(days => (
                <TouchableOpacity key={days} style={s.expiryChip} onPress={() => setDueAt(isoFromNowDays(days))}>
                  <Text style={s.expiryChipText}>+{days}d</Text>
                </TouchableOpacity>
              ))}
              {!!dueAt && (
                <TouchableOpacity style={s.expiryChip} onPress={() => setDueAt(null)}>
                  <Text style={[s.expiryChipText, { color: t.colors.danger }]}>Clear</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        ) : (
          <>
            <FieldLabel style={{ marginTop: 12 }}>Due date</FieldLabel>
            <View style={s.expiryRow}>
              <View style={s.expiryCurrent}>
                <Text style={[s.expiryText, isOverdue && s.overdueText]}>{formatDate(dueAt)}</Text>
              </View>
            </View>
          </>
        )}

        {canEdit && dirty && (
          <PrimaryButton
            label="Save changes"
            onPress={saveFields}
            disabled={locked}
            style={{ marginTop: 12 }}
          />
        )}

        {/* Parts used */}
        <View style={s.sectionHeadRow}>
          <Text style={[s.sectionTitle, { marginTop: 0 }]}>Parts Used</Text>
          {canUseParts && (
            <TouchableOpacity onPress={openUseParts} disabled={locked}>
              <Text style={s.usePartsLink}>+ Use parts</Text>
            </TouchableOpacity>
          )}
        </View>
        {repairParts.length === 0 ? (
          <Text style={s.readonlyNote}>No parts recorded against this repair.</Text>
        ) : (
          repairParts.map(p => {
            const partInfo = getItemById(p.item_id);
            return (
              <View key={p.id} style={s.partRow}>
                <Text style={s.partName}>{partInfo?.name ?? p.item_id}</Text>
                <Text style={s.partQty}>{p.qty} {p.unit}</Text>
              </View>
            );
          })
        )}

        {/* Media */}
        <Text style={s.sectionTitle}>Photos</Text>
        <MediaGallery entityType="repair" entityId={repair.id} canUpload={canEdit} />

        {/* History */}
        <Text style={s.sectionTitle}>History</Text>
        <ActivityFeed entityType="repair" entityId={repair.id} />
      </FormScreen>

      {/* Return-from-repair location picker (equipment completion) */}
      <ModalSheet visible={returnUnitId !== null} onClose={() => confirmReturn(returnLoc)}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <Text style={s.modalTitle}>Return to service</Text>
          <Text style={s.modalSub}>
            This repair is complete, so the unit goes back to available. Optionally
            choose where it returns.
          </Text>
          <FieldLabel style={{ marginTop: 12 }}>Return to Location (optional)</FieldLabel>
          <LocationShelfPicker
            locationValue={returnLoc}
            shelfValue={returnShelf}
            onChangeLocation={setReturnLoc}
            onChangeShelf={setReturnShelf}
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

      {/* Use parts — deduct inventory + record repair_parts */}
      <ModalSheet visible={showUseParts} onClose={() => setShowUseParts(false)}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <Text style={s.modalTitle}>Use parts</Text>
          <Text style={s.modalSub}>
            Deducts stock from inventory and records it as consumed on this repair.
          </Text>

          <FieldLabel style={{ marginTop: 12 }}>Item</FieldLabel>
          <SearchablePicker
            placeholder="Search items…"
            searchFn={partItemSearch}
            value={partItem}
            onSelect={pickPartItem}
          />

          <FieldLabel style={{ marginTop: 12 }}>Location</FieldLabel>
          <LocationShelfPicker
            locationValue={partLocation}
            shelfValue={partShelf}
            onChangeLocation={setPartLocation}
            onChangeShelf={setPartShelf}
          />

          <FieldLabel style={{ marginTop: 12 }}>Quantity</FieldLabel>
          <QuantityStepper
            value={partQty}
            onChange={setPartQty}
            min={0}
            max={MAX_QUANTITY}
            allowDecimal
            unit={partItem ? (getItemById(partItem.id)?.unit ?? undefined) : undefined}
          />
          {!!partError && <Text style={s.errorText}>{partError}</Text>}

          <PrimaryButton
            label="Use Parts"
            onPress={confirmUseParts}
            disabled={locked}
            style={{ marginTop: 16 }}
          />
        </ScrollView>
      </ModalSheet>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: 16, paddingBottom: 48 },
  header: {
    backgroundColor: t.colors.surface, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: t.colors.border, marginBottom: 16, gap: 2,
  },
  entityLabel: { fontSize: 18, fontWeight: '700', color: t.colors.textPrimary },
  entityLink: { color: t.colors.primary },
  entityType: { fontSize: 13, color: t.colors.textSecondary },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  currentStatus: { fontSize: 14, fontWeight: '600', color: t.colors.textPrimary },
  assigneeLine: { fontSize: 13, fontWeight: '600', marginTop: 2 },
  completedAt: { fontSize: 12, color: t.colors.success, fontWeight: '600', marginTop: 2 },
  overdueBadge: {
    backgroundColor: t.colors.dangerBg, borderColor: t.colors.danger, borderWidth: 1,
    borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2,
  },
  overdueBadgeText: { fontSize: 11, fontWeight: '700', color: t.colors.danger },
  overdueText: { color: t.colors.danger, fontWeight: '700' },
  statusRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 6 },
  readonlyNote: { fontSize: 12, color: t.colors.textMuted, marginTop: 8 },
  readonlyValue: { fontSize: 15, color: t.colors.textPrimary, marginTop: 2 },
  multiline: { minHeight: 72, textAlignVertical: 'top' },
  sectionTitle: {
    fontSize: 12, fontWeight: '700', color: t.colors.textMuted,
    textTransform: 'uppercase', letterSpacing: 1, marginTop: 24, marginBottom: 8,
  },
  sectionHeadRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 24, marginBottom: 8,
  },
  usePartsLink: { fontSize: 13, fontWeight: '700', color: t.colors.primary },
  partRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.colors.borderDetail,
  },
  partName: { fontSize: 14, color: t.colors.textPrimary, flex: 1, marginRight: 8 },
  partQty: { fontSize: 13, color: t.colors.textSecondary, fontWeight: '600' },
  expiryRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6 },
  expiryCurrent: {
    flex: 1, backgroundColor: t.colors.background, borderRadius: 10, borderWidth: 1,
    borderColor: t.colors.border, paddingHorizontal: 12, height: 44, justifyContent: 'center',
  },
  expiryText: { fontSize: 14, color: t.colors.textPrimary },
  expiryClear: { color: t.colors.danger, fontSize: 14, fontWeight: '600', paddingHorizontal: 6 },
  chipWrap: { flexDirection: 'row', gap: 8, marginTop: 8 },
  expiryChip: { backgroundColor: t.colors.primaryBg, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  expiryChipText: { color: t.colors.primary, fontSize: 13, fontWeight: '600' },
  errorText: { fontSize: 12, color: t.colors.danger, marginTop: 4 },
  modalTitle: { fontSize: 16, fontWeight: '700', color: t.colors.textPrimary },
  modalSub: { fontSize: 13, color: t.colors.textSecondary, marginTop: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  btn: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10, alignItems: 'center' },
  btnGhost: { borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.surface },
  btnGhostText: { color: t.colors.textSecondary, fontWeight: '600' },
});
