import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Switch } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getItemById, updateItemFields, getDistinctValues,
  InventoryItem,
} from '../../../src/db/queries/items';
import { appendOutbox } from '../../../src/sync/outbox';
import { usePermission } from '../../../src/hooks/usePermission';
import { BarcodeInput } from '../../../src/components/BarcodeInput';
import { SuggestInput } from '../../../src/components/SuggestInput';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { getAllLocations } from '../../../src/db/queries/locations';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import {
  getUnitByTag, upsertUnit, getUnitsForItem, countUnitsByStatus,
  setUnitStatus, EquipmentUnit,
} from '../../../src/db/queries/equipmentUnits';
import { appendLog } from '../../../src/db/queries/log';
import { getRepairsForEntity, updateRepairStatus } from '../../../src/db/queries/repairs';
import { getRepairStatuses, isTerminalStatus } from '../../../src/db/queries/taxonomy';
import { useSession } from '../../../src/hooks/useSession';
import { generateUUID } from '../../../src/utils/uuid';
import { UnitRow } from '../../../src/components/UnitRow';
import ActivityFeed from '../../../src/components/ActivityFeed';
import { colors } from '../../../src/theme';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { AppInput } from '../../../src/components/ui/AppInput';
import { AdvancedFields } from '../../../src/components/ui/AdvancedFields';
import { LabelPrintSheet } from '../../../src/components/LabelPrintSheet';
import { nextAssetTag } from '../../../src/db/queries/equipment';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';

export default function EquipmentModelDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const canEdit = usePermission('edit_inventory');
  const canUpload = usePermission('upload_media');
  const canAddUnits = usePermission('add_inventory');
  const { user } = useSession();
  const { locked } = useMaintenanceMode();

  const API = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

  const [item, setItem] = useState<InventoryItem | null>(() => getItemById(id));
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  const [editCategory, setEditCategory] = useState('');
  const [editReturnable, setEditReturnable] = useState(false);
  const [editTagPrefix, setEditTagPrefix] = useState('');

  const supplierOptions = useMemo(() => getDistinctValues('supplier'), []);
  const modelOptions = useMemo(() => getDistinctValues('model'), []);
  const categoryOptions = useMemo(() => getDistinctValues('category'), []);

  // Add Units modal state
  const [addUnitsOpen, setAddUnitsOpen] = useState(false);
  const [addUnitsLoc, setAddUnitsLoc] = useState<PickerOption | null>(null);
  const [unitRows, setUnitRows] = useState<Array<{ tag: string; serial: string }>>([{ tag: '', serial: '' }]);
  const [tagErrors, setTagErrors] = useState<Record<number, string>>({});
  const [units, setUnits] = useState<EquipmentUnit[]>(() => getUnitsForItem(id));
  const [unitCounts, setUnitCounts] = useState(() => countUnitsByStatus(id));

  // Repair-out modal state (note prompt, cross-platform)

  // Repair-in modal state (location picker)
  const [repairInUnit, setRepairInUnit] = useState<EquipmentUnit | null>(null);
  const [repairInLoc, setRepairInLoc] = useState<PickerOption | null>(null);

  // Unit edit modal state
  const [editUnit, setEditUnit] = useState<EquipmentUnit | null>(null);
  const [editUnitTag, setEditUnitTag] = useState('');
  const [editUnitSerial, setEditUnitSerial] = useState('');
  const [editUnitNotes, setEditUnitNotes] = useState('');

  // Unit history modal state
  const [historyUnit, setHistoryUnit] = useState<EquipmentUnit | null>(null);

  // Per-unit media modal state
  const [unitMediaUnit, setUnitMediaUnit] = useState<EquipmentUnit | null>(null);

  // Label print sheet state
  const [printItemSheet, setPrintItemSheet] = useState(false);
  const [printUnit, setPrintUnit] = useState<EquipmentUnit | null>(null);

  const locationOptions = useMemo<PickerOption[]>(
    () => getAllLocations().map(l => ({ id: l.id, label: l.name })),
    []
  );

  const locationMap = useMemo<Map<string, string>>(
    () => new Map(locationOptions.map(o => [o.id, o.label])),
    [locationOptions]
  );

  // Per-location breakdown of available units
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

  const reload = useCallback(() => {
    setItem(getItemById(id));
    setUnits(getUnitsForItem(id));
    setUnitCounts(countUnitsByStatus(id));
  }, [id]);

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
    setEditCategory(item.category ?? '');
    setEditReturnable(item.returnable === 1);
    setEditTagPrefix(item.tag_prefix ?? '');
    setEditing(true);
  }

  function saveEdit() {
    if (!item) return;
    if (isWriteBlocked()) return;
    if (!form.name?.trim()) { Alert.alert('Required', 'Model name is required.'); return; }
    const fields = {
      name: form.name.trim(),
      model: form.model.trim() || null,
      description: form.description.trim() || null,
      barcode: form.barcode.trim() || null,
      sku: form.sku.trim() || null,
      supplier: form.supplier.trim() || null,
      category: editCategory.trim() || null,
      returnable: (editReturnable ? 1 : 0) as number,
      tag_prefix: editTagPrefix.trim() || null,
    };
    const synced = updateItemFields(item.id, fields);
    // Outbox: send returnable as real boolean (Postgres column is BOOLEAN)
    appendOutbox('UPDATE', 'inventory_items', { ...synced, returnable: editReturnable });
    setEditing(false);
    reload();
  }

  const setField = (k: string) => (v: string) => setForm(f => ({ ...f, [k]: v }));

  // ── Add Units modal helpers ──────────────────────────────────────────────
  function openAddUnits() {
    if (!item) return;
    setAddUnitsLoc(null);
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

  function saveUnits() {
    if (isWriteBlocked()) return;
    if (!addUnitsLoc) {
      Alert.alert('Required', 'Please select a location.');
      return;
    }
    const filledRows = unitRows.filter(r => r.tag.trim());
    if (filledRows.length === 0) {
      Alert.alert('Required', 'Enter at least one asset tag.');
      return;
    }
    // Re-validate all tags on save
    const errors: Record<number, string> = {};
    for (let i = 0; i < unitRows.length; i++) {
      const t = unitRows[i].tag.trim();
      if (!t) continue;
      const err = checkTagError(i, t, unitRows);
      if (err) errors[i] = err;
    }
    if (Object.keys(errors).length > 0) {
      setTagErrors(errors);
      Alert.alert('Duplicate Tags', 'Fix duplicate asset tags before saving.');
      return;
    }
    if (!user || !item) return;

    const locationId = addUnitsLoc.id;
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
        created_at: now,
        updated_at: now,
        synced_at: null,
      };
      upsertUnit(unit);
      appendOutbox('INSERT', 'equipment_units', {
        id: unitId,
        item_id: item.id,
        asset_tag: unit.asset_tag,
        serial_number: unit.serial_number,
        status: 'available',
        current_location_id: locationId,
        current_job_id: null,
        notes: null,
        created_at: now,
        updated_at: now,
        // synced_at intentionally omitted from outbox payload
      });
      addedTags.push(t);
    }

    appendLog({
      user_id: user.id,
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
    reload();
  }

  // ── Repair helpers ───────────────────────────────────────────────────────
  // Putting a unit in repair now goes through "Report repair" (a ticket) — the
  // old note-only repair-out is removed so in_repair always has a Repairs ticket.
  function doRepairIn(unit: EquipmentUnit, locationId: string) {
    if (!user || !item) return;
    if (isWriteBlocked()) return;
    const updated = setUnitStatus(unit.id, { status: 'available', current_location_id: locationId, notes: null });
    appendOutbox('INSERT', 'equipment_units', {
      id: updated.id, item_id: updated.item_id, asset_tag: updated.asset_tag,
      serial_number: updated.serial_number, status: updated.status,
      current_location_id: updated.current_location_id, current_job_id: updated.current_job_id,
      notes: updated.notes, created_at: updated.created_at, updated_at: updated.updated_at,
      // synced_at intentionally omitted
    });
    appendLog({
      user_id: user.id, team_id: null, action: 'repair_in',
      entity_type: 'item', entity_id: item.id,
      from_location_id: null, to_location_id: locationId, quantity: null, unit: null, job_id: null,
      note: 'unit ' + unit.asset_tag,
      metadata: null, device_id: null,
    });
    // Keep the repair ticket(s) in sync: returning a unit completes its open
    // ticket with a terminal status (so the Repairs list shows it as done).
    const terminalLabel = getRepairStatuses().find(s => isTerminalStatus(s.label))?.label;
    if (terminalLabel) {
      for (const r of getRepairsForEntity('equipment_unit', unit.id)) {
        if (r.completed_at == null) updateRepairStatus(r.id, terminalLabel, true);
      }
    }
    setRepairInUnit(null);
    setRepairInLoc(null);
    reload();
  }

  // ── Unit Edit / Retire / History helpers ────────────────────────────────
  function openEditUnit(unit: EquipmentUnit) {
    setEditUnit(unit);
    setEditUnitTag(unit.asset_tag);
    setEditUnitSerial(unit.serial_number ?? '');
    setEditUnitNotes(unit.notes ?? '');
  }

  function saveEditUnit() {
    if (!editUnit || !user) return;
    if (isWriteBlocked()) return;
    if (!editUnitTag.trim()) { Alert.alert('Required', 'Asset tag is required.'); return; }
    const now = new Date().toISOString();
    const changes = {
      asset_tag: editUnitTag.trim(),
      serial_number: editUnitSerial.trim() || null,
      notes: editUnitNotes.trim() || null,
    };
    upsertUnit({ ...editUnit, ...changes, updated_at: now });
    appendOutbox('UPDATE', 'equipment_units', { id: editUnit.id, ...changes, updated_at: now });
    appendLog({
      user_id: user.id, team_id: null, action: 'unit_edited',
      entity_type: 'equipment_unit', entity_id: editUnit.id,
      from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
      note: 'edited ' + editUnit.asset_tag,
      metadata: null, device_id: null,
    });
    setEditUnit(null);
    reload();
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
            const updated = setUnitStatus(unit.id, { status: 'retired' });
            appendOutbox('UPDATE', 'equipment_units', { id: unit.id, status: 'retired', updated_at: updated.updated_at });
            appendLog({
              user_id: user.id, team_id: null, action: 'unit_retired',
              entity_type: 'equipment_unit', entity_id: unit.id,
              from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
              note: 'retired ' + unit.asset_tag,
              metadata: null, device_id: null,
            });
            reload();
          },
        },
      ],
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: editing ? 'Edit Model' : item.name, headerShown: true }} />
      <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
          {editing ? (
            <>
              <Field label="Name *" value={form.name} onChange={setField('name')} autoFocus />
              <SuggestInput label="Color / Model" value={form.model} onChange={setField('model')} suggestions={modelOptions} />
              <Field label="Description" value={form.description} onChange={setField('description')} multiline />
              <BarcodeInput label="Barcode" value={form.barcode} onChange={setField('barcode')} />
              <Field label="SKU / Part #" value={form.sku} onChange={setField('sku')} autoCapitalize="characters" />
              <SuggestInput label="Supplier / Vendor" value={form.supplier} onChange={setField('supplier')} suggestions={supplierOptions} />
              <SuggestInput
                label="Category"
                value={editCategory}
                onChange={setEditCategory}
                suggestions={categoryOptions}
                placeholder="Air Movers, Dehumidifiers…"
              />
              <View style={s.fieldWrap}>
                <FieldLabel>Tag Prefix</FieldLabel>
                <AppInput
                  placeholder="AM-, DH-, MSC-…"
                  value={editTagPrefix}
                  onChangeText={setEditTagPrefix}
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
              </View>
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

              {/* ── Model Photo ───────────────────────────────────────── */}
              <Text style={s.sectionLabel}>Model Photo</Text>
              <MediaGallery entityType="item" entityId={id} canUpload={canUpload} />

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
                        <TouchableOpacity style={s.unitActionBtn} onPress={() => setPrintUnit(u)}>
                          <Text style={s.unitActionText}>Print label</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={s.unitActionBtn} onPress={() => setUnitMediaUnit(u)}>
                          <Text style={s.unitActionText}>Media</Text>
                        </TouchableOpacity>
                        {canEdit && u.status !== 'retired' && u.status !== 'in_repair' && (
                          <TouchableOpacity
                            style={s.unitActionBtn}
                            onPress={() => router.push({
                              pathname: '/(app)/(repairs)/new',
                              params: { entityType: 'equipment_unit', entityId: u.id, entityLabel: u.asset_tag },
                            })}
                          >
                            <Text style={s.unitActionText}>Report repair</Text>
                          </TouchableOpacity>
                        )}
                        {canEdit && u.status === 'in_repair' && (
                          <TouchableOpacity
                            style={s.unitActionBtn}
                            onPress={() => { setRepairInUnit(u); setRepairInLoc(null); }}
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

              <TouchableOpacity style={[s.card, s.attrRow]} onPress={() => setPrintItemSheet(true)}>
                <Text style={s.attrKey}>🏷 Print QR Label</Text>
                <Text style={s.attrVal}>›</Text>
              </TouchableOpacity>

              {canEdit && (
                <PrimaryButton label="Edit Model" onPress={startEdit} />
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Repair-In Modal (location picker) ──────────────────────────── */}
      {/* onClose only hides — repairInLoc is preserved on outside-tap dismiss */}
      <ModalSheet visible={repairInUnit !== null} onClose={() => setRepairInUnit(null)}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <Text style={s.modalTitle}>Return from Repair — {repairInUnit?.asset_tag}</Text>
          <FieldLabel style={{ marginTop: 12 }}>Return to Location *</FieldLabel>
          <SearchablePicker
            placeholder="Search location…"
            options={locationOptions}
            value={repairInLoc}
            onSelect={(opt) => {
              setRepairInLoc(prev => (prev?.id === opt.id ? null : opt));
            }}
          />
          <View style={[s.row, { marginTop: 16 }]}>
            <TouchableOpacity
              style={[s.btn, s.btnGhost]}
              onPress={() => { setRepairInUnit(null); setRepairInLoc(null); }}
            >
              <Text style={s.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <PrimaryButton
              label="Confirm Return"
              onPress={() => {
                if (!repairInLoc) { Alert.alert('Required', 'Please select a location.'); return; }
                if (repairInUnit) doRepairIn(repairInUnit, repairInLoc.id);
              }}
              disabled={locked}
              style={{ flex: 1 }}
            />
          </View>
        </ScrollView>
      </ModalSheet>

      {/* ── Edit Unit Modal ─────────────────────────────────────────────── */}
      <ModalSheet visible={editUnit !== null} onClose={() => setEditUnit(null)}>
        <Text style={s.promptTitle}>Edit Unit</Text>
        <Text style={s.promptSub}>{editUnit?.asset_tag}</Text>
        <FieldLabel style={{ marginTop: 14 }}>Asset Tag *</FieldLabel>
        <AppInput
          value={editUnitTag}
          onChangeText={setEditUnitTag}
          placeholder="Asset tag"
          autoCapitalize="characters"
          autoCorrect={false}
        />
        <AdvancedFields>
          <FieldLabel style={{ marginTop: 10 }}>Serial # (optional)</FieldLabel>
          <AppInput
            value={editUnitSerial}
            onChangeText={setEditUnitSerial}
            placeholder="Serial number"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <FieldLabel style={{ marginTop: 10 }}>Notes (optional)</FieldLabel>
          <AppInput
            style={s.multiline}
            value={editUnitNotes}
            onChangeText={setEditUnitNotes}
            placeholder="Notes"
            multiline
          />
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
      <ModalSheet visible={historyUnit !== null} onClose={() => setHistoryUnit(null)}>
        <Text style={s.modalTitle}>History — {historyUnit?.asset_tag}</Text>
        {historyUnit && (
          <ActivityFeed entityType="equipment_unit" entityId={historyUnit.id} />
        )}
      </ModalSheet>

      {/* ── Per-unit Media Modal ────────────────────────────────────────── */}
      <ModalSheet visible={unitMediaUnit !== null} onClose={() => setUnitMediaUnit(null)}>
        <Text style={s.modalTitle}>Photos — {unitMediaUnit?.asset_tag}</Text>
        {unitMediaUnit && (
          <MediaGallery
            entityType="equipment_unit"
            entityId={unitMediaUnit.id}
            canUpload={canUpload}
          />
        )}
      </ModalSheet>

      {/* ── Print QR Label (model) ─────────────────────────────────────── */}
      <LabelPrintSheet
        visible={printItemSheet}
        onClose={() => setPrintItemSheet(false)}
        title={item.name}
        code={item.barcode ?? item.id}
        qrUrl={`${API}/labels/item/${item.id}/qr.png`}
      />

      {/* ── Print QR Label (unit) ──────────────────────────────────────── */}
      <LabelPrintSheet
        visible={printUnit !== null}
        onClose={() => setPrintUnit(null)}
        title={item.name}
        code={printUnit?.asset_tag ?? ''}
        qrUrl={`${API}/labels/unit/${printUnit?.asset_tag ?? ''}/qr.png`}
      />

      {/* ── Add Units Modal ────────────────────────────────────────────── */}
      {/* onClose only hides (= closeAddUnits); state is reset on next openAddUnits() */}
      <ModalSheet visible={addUnitsOpen} onClose={closeAddUnits}>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 10 }}>
          <Text style={s.modalTitle}>Add Units — {item.name}</Text>

          <FieldLabel>Location *</FieldLabel>
          <SearchablePicker
            placeholder="Search location…"
            options={locationOptions}
            value={addUnitsLoc}
            onSelect={(opt) => {
              setAddUnitsLoc(prev => (prev?.id === opt.id ? null : opt));
            }}
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
              {!!item.tag_prefix && (!row.tag.trim() || row.tag.trim() === item.tag_prefix.trim()) && (
                <TouchableOpacity
                  style={[s.btn, s.btnGhost, { marginTop: 6 }]}
                  onPress={() => updateTag(i, nextAssetTag(item.tag_prefix!))}
                >
                  <Text style={s.btnGhostText}>Generate {item.tag_prefix}…</Text>
                </TouchableOpacity>
              )}
              <AdvancedFields>
                <View style={{ marginTop: 10 }}>
                  <FieldLabel>Serial # (optional)</FieldLabel>
                  <AppInput
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

          <TouchableOpacity style={[s.btn, s.btnGhost, { marginTop: 4 }]} onPress={addUnitRow}>
            <Text style={s.btnGhostText}>+ Add another</Text>
          </TouchableOpacity>

          <View style={s.row}>
            <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={closeAddUnits}>
              <Text style={s.btnGhostText}>Cancel</Text>
            </TouchableOpacity>
            <PrimaryButton label="Save Units" onPress={saveUnits} disabled={locked} style={{ flex: 1 }} />
          </View>
        </ScrollView>
      </ModalSheet>
    </>
  );
}

function Field(props: {
  label: string; value: string; onChange: (v: string) => void;
  multiline?: boolean; keyboardType?: 'decimal-pad'; autoCapitalize?: 'none' | 'characters'; autoFocus?: boolean;
}) {
  return (
    <View style={s.fieldWrap}>
      <FieldLabel>{props.label}</FieldLabel>
      <AppInput
        style={props.multiline ? s.multiline : undefined}
        value={props.value}
        onChangeText={props.onChange}
        multiline={props.multiline}
        keyboardType={props.keyboardType}
        autoCapitalize={props.autoCapitalize}
        autoFocus={props.autoFocus}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 14, color: colors.textMuted },
  card: { backgroundColor: colors.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: colors.borderDetail },
  name: { fontSize: 22, fontWeight: '700', color: colors.brand },
  model: { fontSize: 14, color: colors.primary, marginTop: 2, fontWeight: '600' },
  desc: { fontSize: 14, color: '#475569', marginTop: 8, lineHeight: 20 },
  tagPrefixRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
  tagPrefixLabel: { fontSize: 13, color: colors.textSecondary },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  attrRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11 },
  attrKey: { fontSize: 14, color: colors.textSecondary },
  attrVal: { fontSize: 14, color: colors.textPrimary, fontWeight: '600', maxWidth: '60%', textAlign: 'right' },
  divider: { borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  stockRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  stockLoc: { fontSize: 15, color: colors.textPrimary, fontWeight: '600', flex: 1 },
  stockQty: { fontSize: 15, fontWeight: '700', color: colors.success },
  fieldWrap: { gap: 6 },
  multiline: { height: 80, paddingTop: 12, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 12, marginTop: 16 },
  btn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 8, flex: 1 },
  btnGhost: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.textDisabled },
  btnGhostText: { color: '#475569', fontWeight: '600', fontSize: 16 },
  badge: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 13, fontWeight: '700' },
  badgeTracked: { backgroundColor: colors.primaryBgStrong },
  badgeTrackedText: { color: colors.primaryText, fontWeight: '700', fontSize: 13 },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  switchLabel: { fontSize: 14, color: colors.textPrimary, flex: 1, marginRight: 12 },
  unitActionRow: { flexDirection: 'row', gap: 8, paddingBottom: 8, paddingTop: 2, flexWrap: 'wrap' },
  unitActionBtn: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 5, backgroundColor: '#F1F5F9' },
  unitActionText: { fontSize: 12, fontWeight: '600', color: '#475569' },
  unitActionRetireBtn: { backgroundColor: colors.dangerBg },
  unitActionRetireText: { fontSize: 12, fontWeight: '600', color: '#991B1B' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: colors.brand, marginBottom: 8 },
  promptTitle: { fontSize: 17, fontWeight: '700', color: colors.brand },
  promptSub: { fontSize: 14, color: colors.textSecondary, marginTop: 2 },
  unitFormCard: {
    backgroundColor: colors.surface, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: colors.borderDetail, gap: 0,
  },
  unitSummary: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
});
