import { useMemo, useState } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Switch,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { getItemById, updateItemFields } from '../../../src/repos/items';
import { getAllLocations, resolveLocationShelfSelection } from '../../../src/repos/locations';
import {
  getUnitByTag, upsertUnit, getUnitsForItem, countUnitsByStatus,
  setUnitStatus, markUnitClean, markUnitDirty,
} from '../../../src/repos/equipmentUnits';
import type { EquipmentUnit } from '../../../src/repos/equipmentUnits';
import {
  createMaintenanceEvent, getMaintenanceEventsForUnit, getMaintenanceEventsForItem,
} from '../../../src/repos/maintenance';
import type { MaintenanceEvent } from '../../../src/repos/maintenance';
import { computeBookValue, formatMoney } from '../../../src/equipment/depreciation';
import { appendLog } from '../../../src/db/queries/log';
import { generateUUID } from '../../../src/utils/uuid';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { useDbQuery, useDataVersion } from '@invenpro/core';
import { BarcodeInput } from '../../../src/components/BarcodeInput';
import { UnitRow } from '../../../src/components/UnitRow';
import { PickerOption } from '../../../src/components/SearchablePicker';
import { LocationShelfPicker, TaxonomyChips } from '../../../src/components/pickers';
import { HidableField } from '../../../src/components/ui/HidableField';
import { AdvancedFields } from '../../../src/components/ui/AdvancedFields';
import { AutofillTextField } from '../../../src/components/ui/AutofillTextField';
import {
  parseOptionalCount, parseOptionalDate, parseOptionalNonNegative, validateName, validateText,
} from '../../../src/lib/validation';
import { track } from '../../../src/telemetry';
import { Alert } from '@invenpro/ui';
import type { Theme } from '@invenpro/ui';
import {
  useThemedStyles,
  ModalSheet, PrimaryButton, FieldLabel, FormScreen, TextField, DateField,
  FilterChip, StatusPill, MaintenanceBanner,
} from '@invenpro/ui';
import { RequestApprovalSheet } from '../../../src/components/RequestApprovalSheet';

// Slimmed from apps/mobile/app/(app)/(equipment)/[id].tsx (1253 ln). Cut this
// wave (no infra ported yet — reported, not silently dropped):
//   - MediaGallery (model photo + per-unit photos)         → TODO(wave-media)
//   - LabelPrintSheet (model + unit QR labels)              → labels infra
//     (src/labels/printLabel, LabelPrintSheet) not ported this wave — gap.
//   - DiscussThisButton (chat)                                → TODO(wave-chat)
//   RequestApprovalSheet restored Station B3 (repos/approvals.ts).
//   - PriorRepairsCard, repair-ticket auto-complete on       → TODO(wave-C)
//     "Return from repair" (src/db/queries/repairs.ts, taxonomy repair
//     statuses not ported — the status/location change itself still works)
//   - ActivityFeed (per-unit audit log view)                 → cut, not
//     required by the plan; the activity_log rows themselves are unaffected
// Kept and ported: model edit, unit add/edit/retire, cleanliness toggle,
// per-unit maintenance history + add-event. NEW this wave (not a straight
// port): a model-wide chronological maintenance timeline section — the old
// screen only ever showed maintenance nested inside a per-unit History modal;
// see repos/maintenance.ts's getMaintenanceEventsForItem doc comment.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'equipment_detail', props: { field, rule } });
}

function buildMaintMap(units: EquipmentUnit[]): Map<string, MaintenanceEvent[]> {
  const map = new Map<string, MaintenanceEvent[]>();
  for (const u of units) map.set(u.id, getMaintenanceEventsForUnit(u.id));
  return map;
}

const DEPRECIATION_METHODS = [
  { value: 'straight_line', label: 'Straight line' },
  { value: 'declining_balance', label: 'Declining balance' },
] as const;

export default function EquipmentModelDetailScreen() {
  const s = useThemedStyles(makeStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const canEdit = usePermission('edit_inventory');
  const canAddUnits = usePermission('add_inventory');
  const canViewFinancial = usePermission('view_financial_data');
  const { user, realUser } = useSession();
  const { locked } = useMaintenanceMode();
  const dataVersion = useDataVersion();

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [editType, setEditType] = useState<string | null>(null);
  const [editTypeId, setEditTypeId] = useState<string | null>(null);
  const [editReturnable, setEditReturnable] = useState(false);
  const [editTagPrefix, setEditTagPrefix] = useState('');

  const [addUnitsOpen, setAddUnitsOpen] = useState(false);
  const [addUnitsLoc, setAddUnitsLoc] = useState<PickerOption | null>(null);
  const [addUnitsShelf, setAddUnitsShelf] = useState<PickerOption | null>(null);
  const [unitRows, setUnitRows] = useState<Array<{ tag: string; serial: string }>>([{ tag: '', serial: '' }]);
  const [tagErrors, setTagErrors] = useState<Record<number, string>>({});

  // Item + units + unit-status counts + maintenance history, combined: re-runs
  // whenever a local write OR a background sync pull touches one of these
  // tables (#60/#63).
  const { item, units, unitCounts, maintByUnit, modelMaintenance } = useDbQuery(() => {
    const nextUnits = getUnitsForItem(id);
    return {
      item: getItemById(id),
      units: nextUnits,
      unitCounts: countUnitsByStatus(id),
      maintByUnit: buildMaintMap(nextUnits),
      modelMaintenance: getMaintenanceEventsForItem(id),
    };
  }, [id], ['inventory_items', 'equipment_units', 'maintenance_events']);

  const [maintUnit, setMaintUnit] = useState<EquipmentUnit | null>(null);
  const [maintDate, setMaintDate] = useState('');
  const [maintType, setMaintType] = useState('');
  const [maintNotes, setMaintNotes] = useState('');
  const [maintCost, setMaintCost] = useState('');

  const nowIso = new Date().toISOString();

  const [repairInUnit, setRepairInUnit] = useState<EquipmentUnit | null>(null);
  const [repairInLoc, setRepairInLoc] = useState<PickerOption | null>(null);
  const [repairInShelf, setRepairInShelf] = useState<PickerOption | null>(null);

  const [editUnit, setEditUnit] = useState<EquipmentUnit | null>(null);
  const [editUnitTag, setEditUnitTag] = useState('');
  const [editUnitSerial, setEditUnitSerial] = useState('');
  const [editUnitNotes, setEditUnitNotes] = useState('');
  const [editUnitAcquired, setEditUnitAcquired] = useState('');
  const [editUnitPrice, setEditUnitPrice] = useState('');
  const [editUnitLife, setEditUnitLife] = useState('');
  const [editUnitSalvage, setEditUnitSalvage] = useState('');
  const [editUnitMethod, setEditUnitMethod] = useState('');
  const [editUnitNextService, setEditUnitNextService] = useState('');
  const [editUnitInterval, setEditUnitInterval] = useState('');

  const [historyUnit, setHistoryUnit] = useState<EquipmentUnit | null>(null);
  const [requestApprovalOpen, setRequestApprovalOpen] = useState(false);

  const locationOptions = useMemo<PickerOption[]>(
    () => getAllLocations().map(l => ({ id: l.id, label: l.name })),
    [dataVersion],
  );
  const locationMap = useMemo<Map<string, string>>(
    () => new Map(locationOptions.map(o => [o.id, o.label])),
    [locationOptions],
  );

  const availableByLocation = useMemo(() => {
    const map = new Map<string, { locationId: string; locationName: string; count: number }>();
    for (const u of units) {
      if (u.status === 'available' && u.current_location_id) {
        const locName = locationMap.get(u.current_location_id) ?? u.current_location_id;
        const entry = map.get(u.current_location_id);
        if (entry) { entry.count++; }
        else map.set(u.current_location_id, { locationId: u.current_location_id, locationName: locName, count: 1 });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.locationName.localeCompare(b.locationName));
  }, [units, locationMap]);

  if (!item) {
    return (
      <>
        <Stack.Screen options={{ title: 'Equipment', headerShown: true }} />
        <View style={s.center}><Text style={s.muted}>Equipment model not found.</Text></View>
      </>
    );
  }

  function startEdit() {
    if (!item) return;
    setForm({
      name: item.name,
      model: item.model ?? '',
      description: item.description ?? '',
      barcode: item.barcode ?? '',
      sku: item.sku ?? '',
      supplier: item.supplier ?? '',
    });
    setEditType(item.type ?? null);
    setEditTypeId(item.type_id ?? null);
    setEditReturnable(item.returnable === 1);
    setEditTagPrefix(item.tag_prefix ?? '');
    setEditing(true);
  }

  // updateItemFields self-mirrors to the outbox (repos/items.ts routes it
  // through itemsRepo.update()) — no separate appendOutbox call, unlike the
  // old app's manual appendOutbox('UPDATE', ...) at this call site.
  function saveEdit() {
    if (!item) return;
    if (isWriteBlocked()) return;
    const nameResult = validateName(form.name ?? '', { label: 'Model name' });
    if (!nameResult.ok) { trackReject('item.name', nameResult.rule); Alert.alert('Required', nameResult.error); return; }
    const textChecks = [
      { field: 'item.model', value: form.model ?? '', label: 'Color / Model', max: 200 },
      { field: 'item.description', value: form.description ?? '', label: 'Description', max: 2000 },
      { field: 'item.barcode', value: form.barcode ?? '', label: 'Barcode', max: 512 },
      { field: 'item.sku', value: form.sku ?? '', label: 'SKU / Part #', max: 100 },
      { field: 'item.supplier', value: form.supplier ?? '', label: 'Supplier / Vendor', max: 200 },
      { field: 'item.tag_prefix', value: editTagPrefix, label: 'Tag prefix', max: 20 },
    ] as const;
    for (const c of textChecks) {
      const r = validateText(c.value, { label: c.label, max: c.max });
      if (!r.ok) { trackReject(c.field, r.rule); Alert.alert(`Invalid ${c.label.toLowerCase()}`, r.error); return; }
    }
    updateItemFields(item.id, {
      name: form.name.trim(),
      model: form.model.trim() || null,
      description: form.description.trim() || null,
      barcode: form.barcode.trim() || null,
      sku: form.sku.trim() || null,
      supplier: form.supplier.trim() || null,
      type: editType,
      returnable: (editReturnable ? 1 : 0) as number,
      tag_prefix: editTagPrefix.trim() || null,
    });
    setEditing(false);
  }

  const setField = (k: string) => (v: string) => setForm(f => ({ ...f, [k]: v }));

  // ── Add Units modal helpers ──────────────────────────────────────────────
  function openAddUnits() {
    if (!item) return;
    setAddUnitsLoc(null);
    setAddUnitsShelf(null);
    setUnitRows([{ tag: item.tag_prefix ?? '', serial: '' }]);
    setTagErrors({});
    setAddUnitsOpen(true);
  }

  function closeAddUnits() {
    setAddUnitsOpen(false);
  }

  function checkTagError(
    idx: number,
    tag: string,
    rows: Array<{ tag: string; serial: string }>,
  ): string | undefined {
    const t = tag.trim();
    if (!t) return undefined;
    const batchDup = rows.some((r, i) => i !== idx && r.tag.trim() === t);
    if (batchDup) return 'Duplicate tag in this batch';
    const existing = getUnitByTag(t);
    if (existing) return 'Tag already registered';
    return undefined;
  }

  function updateTag(idx: number, tag: string) {
    const newRows = unitRows.map((r, i) => (i === idx ? { ...r, tag } : r));
    setUnitRows(newRows);
    const err = checkTagError(idx, tag, newRows);
    setTagErrors(prev => {
      const next = { ...prev };
      if (err) next[idx] = err;
      else delete next[idx];
      return next;
    });
  }

  function updateSerial(idx: number, serial: string) {
    setUnitRows(rows => rows.map((r, i) => (i === idx ? { ...r, serial } : r)));
  }

  function addUnitRow() {
    setUnitRows(rows => [...rows, { tag: item?.tag_prefix ?? '', serial: '' }]);
  }

  // upsertUnit self-mirrors to the outbox (repos/equipmentUnits.ts routes it
  // through equipmentUnitsRepo.insert()) — no separate appendOutbox call.
  function saveUnits() {
    if (isWriteBlocked()) return;
    if (!addUnitsLoc) {
      trackReject('equipment_unit.location', 'required');
      Alert.alert('Required', 'Please select a location.');
      return;
    }
    const filledRows = unitRows.filter(r => r.tag.trim());
    if (filledRows.length === 0) {
      trackReject('equipment_unit.asset_tag', 'required');
      Alert.alert('Required', 'Enter at least one asset tag.');
      return;
    }
    const errors: Record<number, string> = {};
    for (let i = 0; i < unitRows.length; i++) {
      const t = unitRows[i].tag.trim();
      if (!t) continue;
      const err = checkTagError(i, t, unitRows);
      if (err) errors[i] = err;
    }
    if (Object.keys(errors).length > 0) {
      trackReject('equipment_unit.asset_tag', 'duplicate');
      setTagErrors(errors);
      Alert.alert('Duplicate Tags', 'Fix duplicate asset tags before saving.');
      return;
    }
    for (const row of unitRows) {
      if (!row.tag.trim()) continue;
      const serialResult = validateText(row.serial, { label: 'Serial number', max: 200 });
      if (!serialResult.ok) {
        trackReject('equipment_unit.serial_number', serialResult.rule);
        Alert.alert('Invalid serial number', serialResult.error);
        return;
      }
    }
    if (!user || !item) return;

    const locRes = resolveLocationShelfSelection(addUnitsLoc, addUnitsShelf);
    if (!locRes.ok) {
      Alert.alert('Could not create shelf', `Could not create shelf "${locRes.shelfLabel}". Please re-pick or re-enter it.`);
      return;
    }
    const locationId = locRes.id as string;
    const addedTags: string[] = [];

    for (const row of unitRows) {
      const t = row.tag.trim();
      if (!t) continue;
      const unitId = generateUUID();
      const now = new Date().toISOString();
      const unit: EquipmentUnit = {
        id: unitId,
        item_id: item.id,
        asset_tag: t,
        serial_number: row.serial.trim() || null,
        status: 'available',
        current_location_id: locationId,
        current_job_id: null,
        notes: null,
        purchase_price: null,
        acquired_at: null,
        useful_life_months: null,
        salvage_value: null,
        depreciation_method: null,
        next_service_at: null,
        service_interval_months: null,
        cleanliness: 'clean',
        jobs_since_clean: 0,
        created_at: now,
        updated_at: now,
        synced_at: null,
      };
      upsertUnit(unit);
      addedTags.push(t);
    }

    appendLog({
      user_id: realUser!.id,
      team_id: null,
      action: 'add_units',
      entity_type: 'item',
      entity_id: item.id,
      from_location_id: null,
      to_location_id: locationId,
      quantity: addedTags.length,
      unit: null,
      job_id: null,
      note: 'units ' + addedTags.join(','),
      metadata: null,
      device_id: null,
    });

    closeAddUnits();
  }

  // ── Repair helpers ───────────────────────────────────────────────────────
  // TODO(wave-C): the old app completed any open repair ticket for this unit
  // here too (src/db/queries/repairs.ts getRepairsForEntity/updateRepairStatus
  // + taxonomy repair-status lookup) — repairs isn't ported this wave, so a
  // unit returned from repair no longer auto-closes its ticket. The status/
  // location change below still applies.
  function doRepairIn(unit: EquipmentUnit, locationId: string) {
    if (!user || !item) return;
    if (isWriteBlocked()) return;
    setUnitStatus(unit.id, { status: 'available', current_location_id: locationId, notes: null });
    appendLog({
      user_id: realUser!.id, team_id: null, action: 'repair_in',
      entity_type: 'item', entity_id: item.id,
      from_location_id: null, to_location_id: locationId, quantity: null, unit: null, job_id: null,
      note: 'unit ' + unit.asset_tag,
      metadata: null, device_id: null,
    });
    setRepairInUnit(null);
    setRepairInLoc(null);
    setRepairInShelf(null);
  }

  // ── Unit Edit / Retire / History helpers ────────────────────────────────
  function openEditUnit(unit: EquipmentUnit) {
    setEditUnit(unit);
    setEditUnitTag(unit.asset_tag);
    setEditUnitSerial(unit.serial_number ?? '');
    setEditUnitNotes(unit.notes ?? '');
    setEditUnitAcquired(unit.acquired_at ? unit.acquired_at.slice(0, 10) : '');
    setEditUnitPrice(unit.purchase_price != null ? String(unit.purchase_price) : '');
    setEditUnitLife(unit.useful_life_months != null ? String(unit.useful_life_months) : '');
    setEditUnitSalvage(unit.salvage_value != null ? String(unit.salvage_value) : '');
    setEditUnitMethod(unit.depreciation_method ?? '');
    setEditUnitNextService(unit.next_service_at ? unit.next_service_at.slice(0, 10) : '');
    setEditUnitInterval(unit.service_interval_months != null ? String(unit.service_interval_months) : '');
  }

  // upsertUnit self-mirrors the whole-row write to the outbox — no separate
  // appendOutbox call, unlike the old app's manual UPDATE payload here.
  function saveEditUnit() {
    if (!editUnit || !user) return;
    if (isWriteBlocked()) return;
    const tagResult = validateName(editUnitTag, { label: 'Asset tag' });
    if (!tagResult.ok) { trackReject('equipment_unit.asset_tag', tagResult.rule); Alert.alert('Required', tagResult.error); return; }
    const serialResult = validateText(editUnitSerial, { label: 'Serial number', max: 200 });
    if (!serialResult.ok) { trackReject('equipment_unit.serial_number', serialResult.rule); Alert.alert('Invalid serial number', serialResult.error); return; }
    const notesResult = validateText(editUnitNotes, { label: 'Notes' });
    if (!notesResult.ok) { trackReject('equipment_unit.notes', notesResult.rule); Alert.alert('Invalid notes', notesResult.error); return; }
    const acquiredResult = parseOptionalDate(editUnitAcquired, 'Acquired date');
    if (!acquiredResult.ok) { trackReject('equipment_unit.acquired_at', acquiredResult.rule); Alert.alert('Invalid date', acquiredResult.error); return; }
    const lifeResult = parseOptionalCount(editUnitLife, 'Useful life (months)');
    if (!lifeResult.ok) { trackReject('equipment_unit.useful_life_months', lifeResult.rule); Alert.alert('Invalid useful life', lifeResult.error); return; }
    const nextServiceResult = parseOptionalDate(editUnitNextService, 'Next service date');
    if (!nextServiceResult.ok) { trackReject('equipment_unit.next_service_at', nextServiceResult.rule); Alert.alert('Invalid date', nextServiceResult.error); return; }
    const intervalResult = parseOptionalCount(editUnitInterval, 'Service interval (months)');
    if (!intervalResult.ok) { trackReject('equipment_unit.service_interval_months', intervalResult.rule); Alert.alert('Invalid service interval', intervalResult.error); return; }
    const now = new Date().toISOString();
    const changes: Partial<EquipmentUnit> = {
      asset_tag: tagResult.value,
      serial_number: serialResult.value || null,
      notes: notesResult.value || null,
      acquired_at: acquiredResult.value,
      useful_life_months: lifeResult.value,
      depreciation_method: editUnitMethod || null,
      next_service_at: nextServiceResult.value,
      service_interval_months: intervalResult.value,
    };
    if (canViewFinancial) {
      const priceResult = parseOptionalNonNegative(editUnitPrice, 'Purchase price');
      if (!priceResult.ok) { trackReject('equipment_unit.purchase_price', priceResult.rule); Alert.alert('Invalid purchase price', priceResult.error); return; }
      const salvageResult = parseOptionalNonNegative(editUnitSalvage, 'Salvage value');
      if (!salvageResult.ok) { trackReject('equipment_unit.salvage_value', salvageResult.rule); Alert.alert('Invalid salvage value', salvageResult.error); return; }
      changes.purchase_price = priceResult.value;
      changes.salvage_value = salvageResult.value;
    }
    upsertUnit({ ...editUnit, ...changes, updated_at: now });
    appendLog({
      user_id: realUser!.id, team_id: null, action: 'unit_edited',
      entity_type: 'equipment_unit', entity_id: editUnit.id,
      from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
      note: 'edited ' + editUnit.asset_tag,
      metadata: null, device_id: null,
    });
    setEditUnit(null);
  }

  // #248: manual mark clean/dirty — no confirm (per decision), disabled while
  // maintenance-locked. markUnitClean/markUnitDirty self-mirror their UPDATE.
  function toggleUnitCleanliness(unit: EquipmentUnit) {
    if (!realUser) return;
    if (isWriteBlocked()) return;
    const wasDirty = unit.cleanliness === 'dirty';
    const updated = wasDirty ? markUnitClean(unit.id) : markUnitDirty(unit.id);
    appendLog({
      user_id: realUser.id, team_id: null,
      action: wasDirty ? 'unit_marked_clean' : 'unit_marked_dirty',
      entity_type: 'equipment_unit', entity_id: unit.id,
      from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
      note: unit.asset_tag,
      metadata: null, device_id: null,
    });
    setEditUnit(updated);
  }

  function doRetireUnit(unit: EquipmentUnit) {
    if (!user) return;
    if (isWriteBlocked()) return;
    Alert.alert(
      'Retire Unit',
      `Retire ${unit.asset_tag}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Retire', style: 'destructive',
          onPress: () => {
            setUnitStatus(unit.id, { status: 'retired' });
            appendLog({
              user_id: realUser!.id, team_id: null, action: 'unit_retired',
              entity_type: 'equipment_unit', entity_id: unit.id,
              from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
              note: 'retired ' + unit.asset_tag,
              metadata: null, device_id: null,
            });
          },
        },
      ],
    );
  }

  // ── Maintenance event helpers ────────────────────────────────────────────
  function openAddMaint(unit: EquipmentUnit) {
    setMaintUnit(unit);
    setMaintDate(new Date().toISOString().slice(0, 10));
    setMaintType('');
    setMaintNotes('');
    setMaintCost('');
  }

  function saveMaint() {
    if (!maintUnit || !user) return;
    if (isWriteBlocked()) return;
    if (!maintType.trim()) {
      trackReject('maintenance.type', 'required');
      Alert.alert('Required', 'Enter a maintenance type.');
      return;
    }
    const typeResult = validateText(maintType, { label: 'Maintenance type', max: 100 });
    if (!typeResult.ok) { trackReject('maintenance.type', typeResult.rule); Alert.alert('Invalid maintenance type', typeResult.error); return; }
    const notesResult = validateText(maintNotes, { label: 'Notes' });
    if (!notesResult.ok) { trackReject('maintenance.notes', notesResult.rule); Alert.alert('Invalid notes', notesResult.error); return; }
    const dateResult = parseOptionalDate(maintDate, 'Date');
    if (!dateResult.ok) { trackReject('maintenance.event_date', dateResult.rule); Alert.alert('Invalid date', dateResult.error); return; }
    const eventDate = dateResult.value ?? new Date().toISOString();
    let cost: number | null = null;
    if (canViewFinancial) {
      const costResult = parseOptionalNonNegative(maintCost, 'Cost');
      if (!costResult.ok) { trackReject('maintenance.cost', costResult.rule); Alert.alert('Invalid cost', costResult.error); return; }
      cost = costResult.value;
    }
    createMaintenanceEvent({
      unitId: maintUnit.id,
      eventDate,
      type: typeResult.value,
      notes: notesResult.value || null,
      cost,
      userId: user.id,
    });
    setMaintUnit(null);
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: editing ? 'Edit Model' : item.name,
          headerShown: true,
        }}
      />
      <FormScreen contentContainerStyle={s.content}>
          {editing ? (
            <>
              <TextField label="Name" required value={form.name} onChangeText={setField('name')} autoFocus />
              <AutofillTextField label="Color / Model" table="inventory_items" column="model" value={form.model} onChangeText={setField('model')} />
              <TextField label="Description" value={form.description} onChangeText={setField('description')} multiline />
              <BarcodeInput label="Barcode" value={form.barcode} onChange={setField('barcode')} />
              <TextField label="SKU / Part #" value={form.sku} onChangeText={setField('sku')} autoCapitalize="characters" />
              <AutofillTextField label="Supplier / Vendor" table="inventory_items" column="supplier" value={form.supplier} onChangeText={setField('supplier')} />
              <HidableField fieldId="equipment.type">
                <View style={s.fieldWrap}>
                  <TaxonomyChips
                    category="equipment"
                    label="Type"
                    withFallback
                    deselectable
                    valueId={editTypeId}
                    valueLabel={editType}
                    onChange={v => { setEditType(v.label); setEditTypeId(v.id); }}
                  />
                </View>
              </HidableField>
              <TextField
                label="Tag Prefix"
                placeholder="AM-, DH-, MSC-…"
                value={editTagPrefix}
                onChangeText={setEditTagPrefix}
                autoCapitalize="characters"
                autoCorrect={false}
              />
              <View style={s.switchRow}>
                <Text style={s.switchLabel}>Returnable? (expected back via Check In)</Text>
                <Switch value={editReturnable} onValueChange={setEditReturnable} />
              </View>

              <View style={s.row}>
                <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={() => setEditing(false)}>
                  <Text style={s.btnGhostText}>Cancel</Text>
                </TouchableOpacity>
                <PrimaryButton label="Save Changes" onPress={saveEdit} disabled={locked} style={{ flex: 1 }} />
              </View>
            </>
          ) : (
            <>
              {/* ── Model Header ──────────────────────────────────────── */}
              <View style={s.card}>
                <Text style={s.name}>{item.name}</Text>
                {!!item.model && <Text style={s.model}>{item.model}</Text>}
                {!!item.description && <Text style={s.desc}>{item.description}</Text>}
                {!!item.tag_prefix && (
                  <View style={s.tagPrefixRow}>
                    <Text style={s.tagPrefixLabel}>Tag prefix</Text>
                    <View style={[s.badge, s.badgeTracked]}>
                      <Text style={[s.badgeText, s.badgeTrackedText]}>{item.tag_prefix}</Text>
                    </View>
                  </View>
                )}
              </View>

              {locked && <MaintenanceBanner />}

              {/* ── Unit Summary ──────────────────────────────────────── */}
              <Text style={s.sectionLabel}>Units on Hand</Text>
              <View style={s.card}>
                <Text style={s.unitSummary}>
                  {unitCounts.available} available
                  {unitCounts.deployed > 0 ? ` · ${unitCounts.deployed} deployed` : ''}
                  {unitCounts.in_repair > 0 ? ` · ${unitCounts.in_repair} in repair` : ''}
                  {unitCounts.retired > 0 ? ` · ${unitCounts.retired} retired` : ''}
                </Text>
                {availableByLocation.length > 0 && (
                  <View style={{ marginTop: 10 }}>
                    {availableByLocation.map((loc, i) => (
                      <View
                        key={loc.locationId}
                        style={[s.stockRow, i < availableByLocation.length - 1 && s.divider]}
                      >
                        <Text style={s.stockLoc}>{loc.locationName}</Text>
                        <Text style={s.stockQty}>{loc.count} available</Text>
                      </View>
                    ))}
                  </View>
                )}
              </View>

              {/* ── Registered Units ──────────────────────────────────── */}
              <Text style={s.sectionLabel}>Registered Units</Text>
              <View style={s.card}>
                {units.length === 0 ? (
                  <Text style={s.muted}>No units registered yet.</Text>
                ) : (
                  units.map((u, i) => (
                    <View key={u.id} style={i < units.length - 1 ? s.divider : undefined}>
                      <UnitRow
                        unit={u}
                        locationName={u.current_location_id ? (locationMap.get(u.current_location_id) ?? null) : null}
                      />
                      <View style={s.unitActionRow}>
                        <TouchableOpacity style={s.unitActionBtn} onPress={() => setHistoryUnit(u)}>
                          <Text style={s.unitActionText}>History</Text>
                        </TouchableOpacity>
                        {canEdit && u.status !== 'retired' && u.status !== 'in_repair' && (
                          <TouchableOpacity
                            style={s.unitActionBtn}
                            // TODO(wave-C): repairs isn't ported yet — cast
                            // bypasses expo-router's typed-routes check.
                            onPress={() => router.push({
                              pathname: '/(app)/repairs/new',
                              params: { entityType: 'equipment_unit', entityId: u.id, entityLabel: u.asset_tag },
                            } as never)}
                          >
                            <Text style={s.unitActionText}>Report repair</Text>
                          </TouchableOpacity>
                        )}
                        {canEdit && u.status === 'in_repair' && (
                          <TouchableOpacity
                            style={s.unitActionBtn}
                            onPress={() => { setRepairInUnit(u); setRepairInLoc(null); setRepairInShelf(null); }}
                          >
                            <Text style={s.unitActionText}>Return from repair</Text>
                          </TouchableOpacity>
                        )}
                        {canEdit && u.status !== 'retired' && (
                          <>
                            <TouchableOpacity style={s.unitActionBtn} onPress={() => openEditUnit(u)}>
                              <Text style={s.unitActionText}>Edit</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              style={[s.unitActionBtn, s.unitActionRetireBtn]}
                              onPress={() => doRetireUnit(u)}
                              disabled={locked}
                            >
                              <Text style={s.unitActionRetireText}>Retire</Text>
                            </TouchableOpacity>
                          </>
                        )}
                      </View>
                    </View>
                  ))
                )}
              </View>

              {canAddUnits && (
                <PrimaryButton label="+ Add Units" onPress={openAddUnits} />
              )}

              {/* ── Maintenance timeline (model-wide) ──────────────────── */}
              {/* NEW this wave: merged, chronological maintenance_events across
                  every unit of this model — the old screen only showed history
                  nested per-unit (see History below, still kept for per-unit
                  detail + adding new events). */}
              <Text style={s.sectionLabel}>Maintenance Timeline</Text>
              <View style={s.card}>
                {modelMaintenance.length === 0 ? (
                  <Text style={s.muted}>No maintenance logged for this model.</Text>
                ) : (
                  modelMaintenance.map((ev, i) => (
                    <View key={ev.id} style={[s.maintRow, i < modelMaintenance.length - 1 && s.divider]}>
                      <View style={s.maintRowMain}>
                        <Text style={s.maintDate}>
                          {new Date(ev.event_date).toLocaleDateString()} · {ev.type} · {ev.asset_tag}
                        </Text>
                        {!!ev.notes && <Text style={s.maintNotes}>{ev.notes}</Text>}
                      </View>
                      {canViewFinancial && ev.cost != null && (
                        <Text style={s.maintCost}>{formatMoney(ev.cost)}</Text>
                      )}
                    </View>
                  ))
                )}
              </View>

              {/* Request Approval — restored Station B3 (repos/approvals.ts). */}
              <PrimaryButton
                label="Request Approval"
                onPress={() => setRequestApprovalOpen(true)}
                style={{ marginBottom: canEdit ? 8 : 0 }}
              />

              {canEdit && (
                <PrimaryButton label="Edit Model" onPress={startEdit} />
              )}
            </>
          )}
      </FormScreen>

      {/* ── Repair-In Modal (location picker) ──────────────────────────── */}
      <ModalSheet visible={repairInUnit !== null} onClose={() => setRepairInUnit(null)} scroll={false}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <Text style={s.modalTitle}>Return from Repair — {repairInUnit?.asset_tag}</Text>
          <FieldLabel style={{ marginTop: 12 }}>Return to Location *</FieldLabel>
          <LocationShelfPicker
            locationValue={repairInLoc}
            shelfValue={repairInShelf}
            onChangeLocation={setRepairInLoc}
            onChangeShelf={setRepairInShelf}
          />
          <View style={[s.row, { marginTop: 16 }]}>
            <TouchableOpacity
              style={[s.btn, s.btnGhost]}
              onPress={() => { setRepairInUnit(null); setRepairInLoc(null); setRepairInShelf(null); }}
            >
              <Text style={s.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <PrimaryButton
              label="Confirm Return"
              onPress={() => {
                if (!repairInLoc) { trackReject('equipment_unit.location', 'required'); Alert.alert('Required', 'Please select a location.'); return; }
                const locRes = resolveLocationShelfSelection(repairInLoc, repairInShelf);
                if (!locRes.ok) { Alert.alert('Could not create shelf', `Could not create shelf "${locRes.shelfLabel}". Please re-pick or re-enter it.`); return; }
                if (repairInUnit) doRepairIn(repairInUnit, locRes.id as string);
              }}
              disabled={locked}
              style={{ flex: 1 }}
            />
          </View>
        </ScrollView>
      </ModalSheet>

      {/* ── Edit Unit Modal ─────────────────────────────────────────────── */}
      <ModalSheet visible={editUnit !== null} onClose={() => setEditUnit(null)} scroll>
        <Text style={s.promptTitle}>Edit Unit</Text>
        <Text style={s.promptSub}>{editUnit?.asset_tag}</Text>
        <View style={{ marginTop: 14 }}>
          <TextField
            label="Asset Tag"
            required
            value={editUnitTag}
            onChangeText={setEditUnitTag}
            placeholder="Asset tag"
            autoCapitalize="characters"
            autoCorrect={false}
          />
        </View>
        {editUnit && (
          <TouchableOpacity
            style={[s.row, { marginTop: 10, alignItems: 'center', justifyContent: 'space-between' }]}
            onPress={() => toggleUnitCleanliness(editUnit)}
            disabled={locked}
          >
            <StatusPill
              label={editUnit.cleanliness === 'dirty' ? 'Needs cleaning' : 'Clean'}
              tone={editUnit.cleanliness === 'dirty' ? 'warning' : 'success'}
            />
            <Text style={s.btnGhostText}>{editUnit.cleanliness === 'dirty' ? 'Mark clean' : 'Mark dirty'}</Text>
          </TouchableOpacity>
        )}
        <AdvancedFields>
          <HidableField fieldId="equipment.serial_number">
            <View style={{ marginTop: 10 }}>
              <TextField
                label="Serial # (optional)"
                value={editUnitSerial}
                onChangeText={setEditUnitSerial}
                placeholder="Serial number"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </HidableField>
          <HidableField fieldId="equipment.notes">
            <View style={{ marginTop: 10 }}>
              <TextField
                label="Notes (optional)"
                value={editUnitNotes}
                onChangeText={setEditUnitNotes}
                placeholder="Notes"
                multiline
              />
            </View>
          </HidableField>
          <HidableField fieldId="equipment.acquired_at">
            <View style={{ marginTop: 10 }}>
              <DateField label="Acquired date (optional)" value={editUnitAcquired} onChange={setEditUnitAcquired} />
            </View>
          </HidableField>
          {canViewFinancial && (
            <HidableField fieldId="equipment.purchase_price">
              <View style={{ marginTop: 10 }}>
                <TextField
                  label="Purchase price (optional)"
                  value={editUnitPrice}
                  onChangeText={setEditUnitPrice}
                  placeholder="0.00"
                  keyboardType="numeric"
                />
              </View>
            </HidableField>
          )}
          <HidableField fieldId="equipment.depreciation">
            <View style={{ marginTop: 10 }}>
              <TextField
                label="Useful life (months)"
                value={editUnitLife}
                onChangeText={setEditUnitLife}
                placeholder="e.g. 60"
                keyboardType="numeric"
              />
            </View>
            {canViewFinancial && (
              <View style={{ marginTop: 10 }}>
                <TextField
                  label="Salvage value (optional)"
                  value={editUnitSalvage}
                  onChangeText={setEditUnitSalvage}
                  placeholder="0.00"
                  keyboardType="numeric"
                />
              </View>
            )}
            <FieldLabel style={{ marginTop: 10 }}>Depreciation method</FieldLabel>
            <View style={s.methodRow}>
              {DEPRECIATION_METHODS.map(m => (
                <FilterChip
                  key={m.value}
                  label={m.label}
                  active={editUnitMethod === m.value}
                  onPress={() => setEditUnitMethod(prev => (prev === m.value ? '' : m.value))}
                />
              ))}
            </View>
          </HidableField>
          <HidableField fieldId="equipment.service_schedule">
            <View style={{ marginTop: 10 }}>
              <DateField label="Next service date (optional)" value={editUnitNextService} onChange={setEditUnitNextService} />
            </View>
            <View style={{ marginTop: 10 }}>
              <TextField
                label="Service interval (months)"
                value={editUnitInterval}
                onChangeText={setEditUnitInterval}
                placeholder="e.g. 6"
                keyboardType="numeric"
              />
            </View>
          </HidableField>
        </AdvancedFields>
        <View style={[s.row, { marginTop: 16 }]}>
          <TouchableOpacity
            style={[s.btn, s.btnGhost]}
            onPress={() => setEditUnit(null)}
          >
            <Text style={s.btnGhostText}>Cancel</Text>
          </TouchableOpacity>
          <PrimaryButton label="Save" onPress={saveEditUnit} disabled={locked} style={{ flex: 1 }} />
        </View>
      </ModalSheet>

      {/* ── Unit History Modal ──────────────────────────────────────────── */}
      <ModalSheet visible={historyUnit !== null} onClose={() => setHistoryUnit(null)} scroll>
        <Text style={s.modalTitle}>History — {historyUnit?.asset_tag}</Text>
        {historyUnit && (() => {
          const events = maintByUnit.get(historyUnit.id) ?? [];
          const bookValue = canViewFinancial ? computeBookValue(historyUnit, nowIso) : null;
          return (
            <View style={s.maintBlock}>
              <View style={s.maintHeaderRow}>
                <Text style={s.maintUnitTag}>Maintenance</Text>
                {canViewFinancial && bookValue != null && (
                  <Text style={s.maintBookValue}>Book value {formatMoney(bookValue)}</Text>
                )}
              </View>
              {events.length === 0 ? (
                <Text style={s.maintEmpty}>No maintenance logged.</Text>
              ) : (
                events.map(ev => (
                  <View key={ev.id} style={s.maintRow}>
                    <View style={s.maintRowMain}>
                      <Text style={s.maintDate}>
                        {new Date(ev.event_date).toLocaleDateString()} · {ev.type}
                      </Text>
                      {!!ev.notes && <Text style={s.maintNotes}>{ev.notes}</Text>}
                    </View>
                    {canViewFinancial && ev.cost != null && (
                      <Text style={s.maintCost}>{formatMoney(ev.cost)}</Text>
                    )}
                  </View>
                ))
              )}
              {canEdit && (
                <TouchableOpacity
                  style={s.maintAddBtn}
                  // Close this sheet BEFORE opening the log-maintenance one —
                  // two visible Modals is the nested-Modal trap.
                  onPress={() => { const u = historyUnit; setHistoryUnit(null); openAddMaint(u); }}
                  disabled={locked}
                >
                  <Text style={s.maintAddText}>+ Add maintenance event</Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })()}
      </ModalSheet>

      {/* ── Add Maintenance Event Modal ─────────────────────────────────── */}
      <ModalSheet visible={maintUnit !== null} onClose={() => setMaintUnit(null)} scroll={false}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <Text style={s.promptTitle}>Log Maintenance</Text>
          <Text style={s.promptSub}>{maintUnit?.asset_tag}</Text>

          <View style={{ marginTop: 14 }}>
            <DateField label="Date" value={maintDate} onChange={setMaintDate} />
          </View>

          <View style={{ marginTop: 10 }}>
            <TextField
              label="Type"
              required
              value={maintType}
              onChangeText={setMaintType}
              placeholder="Inspection, oil change, calibration…"
            />
          </View>

          <View style={{ marginTop: 10 }}>
            <TextField
              label="Notes (optional)"
              value={maintNotes}
              onChangeText={setMaintNotes}
              placeholder="Notes"
              multiline
            />
          </View>

          {canViewFinancial && (
            <View style={{ marginTop: 10 }}>
              <TextField
                label="Cost (optional)"
                value={maintCost}
                onChangeText={setMaintCost}
                placeholder="0.00"
                keyboardType="numeric"
              />
            </View>
          )}

          <View style={[s.row, { marginTop: 16 }]}>
            <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={() => setMaintUnit(null)}>
              <Text style={s.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <PrimaryButton label="Save" onPress={saveMaint} disabled={locked} style={{ flex: 1 }} />
          </View>
        </ScrollView>
      </ModalSheet>

      {/* ── Add Units Modal ────────────────────────────────────────────── */}
      <ModalSheet visible={addUnitsOpen} onClose={closeAddUnits} scroll={false}>
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flexShrink: 1 }} contentContainerStyle={{ gap: 10 }}>
          <Text style={s.modalTitle}>Add Units — {item.name}</Text>

          <FieldLabel>Location *</FieldLabel>
          <LocationShelfPicker
            locationValue={addUnitsLoc}
            shelfValue={addUnitsShelf}
            onChangeLocation={setAddUnitsLoc}
            onChangeShelf={setAddUnitsShelf}
          />

          <Text style={[s.sectionLabel, { marginTop: 8 }]}>Unit Rows</Text>
          {unitRows.map((row, i) => (
            <View key={i} style={s.unitFormCard}>
              <BarcodeInput
                label={`Asset Tag ${i + 1}`}
                value={row.tag}
                onChange={(v) => updateTag(i, v)}
                placeholder="Asset tag / barcode"
                note={tagErrors[i]}
                noteTone="warn"
              />
              <AdvancedFields>
                <View style={{ marginTop: 10 }}>
                  <TextField
                    label="Serial # (optional)"
                    value={row.serial}
                    onChangeText={(v) => updateSerial(i, v)}
                    placeholder="Serial number"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              </AdvancedFields>
            </View>
          ))}
        </ScrollView>

        <TouchableOpacity style={[s.btn, s.btnGhost, { marginTop: 10 }]} onPress={addUnitRow}>
          <Text style={s.btnGhostText}>+ Add another</Text>
        </TouchableOpacity>

        <View style={s.row}>
          <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={closeAddUnits}>
            <Text style={s.btnGhostText}>Cancel</Text>
          </TouchableOpacity>
          <PrimaryButton label="Save Units" onPress={saveUnits} disabled={locked} style={{ flex: 1 }} />
        </View>
      </ModalSheet>

      {/* ── Request approval on this model (#025, restored Station B3) ────── */}
      <RequestApprovalSheet
        visible={requestApprovalOpen}
        onClose={() => setRequestApprovalOpen(false)}
        entityType="item"
        entityId={item.id}
        entityLabel={item.name}
      />
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 14, color: t.colors.textMuted },
  card: { backgroundColor: t.colors.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: t.colors.borderDetail },
  name: { fontSize: 22, fontWeight: '700', color: t.colors.brand },
  model: { fontSize: 14, color: t.colors.primary, marginTop: 2, fontWeight: '600' },
  desc: { fontSize: 14, color: '#475569', marginTop: 8, lineHeight: 20 },
  tagPrefixRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  tagPrefixLabel: { fontSize: 13, color: t.colors.textSecondary },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: t.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  divider: { borderBottomWidth: 1, borderBottomColor: t.colors.surfaceAlt },
  stockRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  stockLoc: { fontSize: 15, color: t.colors.textPrimary, fontWeight: '600', flex: 1 },
  stockQty: { fontSize: 15, fontWeight: '700', color: t.colors.success },
  fieldWrap: { gap: 6 },
  methodRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  row: { flexDirection: 'row', gap: 12, marginTop: 16 },
  btn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 8, flex: 1 },
  btnGhost: { backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.textDisabled },
  btnGhostText: { color: '#475569', fontWeight: '600', fontSize: 16 },
  badge: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 13, fontWeight: '700' },
  badgeTracked: { backgroundColor: t.colors.primaryBgStrong },
  badgeTrackedText: { color: t.colors.primaryText, fontWeight: '700', fontSize: 13 },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: t.colors.surface, borderRadius: 10, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  switchLabel: { fontSize: 14, color: t.colors.textPrimary, flex: 1, marginRight: 12 },
  unitActionRow: { flexDirection: 'row', gap: 8, paddingBottom: 8, paddingTop: 2, flexWrap: 'wrap' },
  unitActionBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5, backgroundColor: t.colors.surfaceAlt },
  unitActionText: { fontSize: 12, fontWeight: '600', color: '#475569' },
  unitActionRetireBtn: { backgroundColor: t.colors.dangerBg },
  unitActionRetireText: { fontSize: 12, fontWeight: '600', color: '#991B1B' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: t.colors.brand, marginBottom: 8 },
  promptTitle: { fontSize: 17, fontWeight: '700', color: t.colors.brand },
  promptSub: { fontSize: 14, color: t.colors.textSecondary, marginTop: 2 },
  unitFormCard: {
    backgroundColor: t.colors.surface, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: t.colors.borderDetail, gap: 0,
  },
  unitSummary: { fontSize: 15, fontWeight: '600', color: t.colors.textPrimary },
  maintBlock: { paddingVertical: 12 },
  maintHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  maintUnitTag: { fontSize: 15, fontWeight: '700', color: t.colors.textPrimary },
  maintBookValue: { fontSize: 13, fontWeight: '700', color: t.colors.primaryText },
  maintEmpty: { fontSize: 13, color: t.colors.textMuted, marginTop: 6 },
  maintRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingVertical: 8, gap: 12 },
  maintRowMain: { flex: 1 },
  maintDate: { fontSize: 14, color: t.colors.textPrimary, fontWeight: '600' },
  maintNotes: { fontSize: 13, color: t.colors.textSecondary, marginTop: 2, lineHeight: 18 },
  maintCost: { fontSize: 14, fontWeight: '700', color: t.colors.textPrimary },
  maintAddBtn: { alignSelf: 'flex-start', borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: t.colors.primaryBg, marginTop: 10 },
  maintAddText: { fontSize: 12, fontWeight: '700', color: t.colors.primaryText },
});
