import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, Alert, KeyboardAvoidingView, Platform, Switch, Modal,
} from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import {
  getItemById, getStockByItem, updateItemFields, getDistinctValues,
  InventoryItem, StockByLocation,
} from '../../../src/db/queries/items';
import { appendOutbox } from '../../../src/sync/outbox';
import { usePermission } from '../../../src/hooks/usePermission';
import { UnitCategory, UNIT_CATEGORY_LABELS, formatQuantity } from '../../../src/constants/units';
import { BarcodeInput } from '../../../src/components/BarcodeInput';
import { SuggestInput } from '../../../src/components/SuggestInput';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { getAllLocations } from '../../../src/db/queries/locations';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { getUnitByTag, upsertUnit, getUnitsForItem, countUnitsByStatus, setUnitStatus, EquipmentUnit } from '../../../src/db/queries/equipmentUnits';
import { appendLog } from '../../../src/db/queries/log';
import { useSession } from '../../../src/hooks/useSession';
import { generateUUID } from '../../../src/utils/uuid';
import { UnitRow } from '../../../src/components/UnitRow';

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const canEdit = usePermission('edit_inventory');
  const canUpload = usePermission('upload_media');
  const canAddUnits = usePermission('add_inventory');
  const { user } = useSession();

  const [item, setItem] = useState<InventoryItem | null>(() => getItemById(id));
  const [stock, setStock] = useState<StockByLocation[]>(() => getStockByItem(id));
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  // Edit-mode state for new fields (outside the string-keyed form record)
  const [editCategory, setEditCategory] = useState('');
  const [editReturnable, setEditReturnable] = useState(false);
  const [editUnitTracked, setEditUnitTracked] = useState(false);
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
  const [repairOutUnit, setRepairOutUnit] = useState<EquipmentUnit | null>(null);
  const [repairNote, setRepairNote] = useState('');

  // Repair-in modal state (location picker)
  const [repairInUnit, setRepairInUnit] = useState<EquipmentUnit | null>(null);
  const [repairInLoc, setRepairInLoc] = useState<PickerOption | null>(null);

  const locationOptions = useMemo<PickerOption[]>(
    () => getAllLocations().map(l => ({ id: l.id, label: l.name })),
    []
  );

  const locationMap = useMemo<Map<string, string>>(
    () => new Map(locationOptions.map(o => [o.id, o.label])),
    [locationOptions]
  );

  const total = useMemo(
    () => item?.unit_tracked === 1
      ? unitCounts.available
      : stock.reduce((sum, st) => sum + st.quantity, 0),
    [item, stock, unitCounts]
  );

  // Per-location breakdown of available units (unit-tracked items only)
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
    setStock(getStockByItem(id));
    setUnits(getUnitsForItem(id));
    setUnitCounts(countUnitsByStatus(id));
  }, [id]);

  if (!item) {
    return (
      <>
        <Stack.Screen options={{ title: 'Item', headerShown: true }} />
        <View style={s.center}><Text style={s.muted}>Item not found.</Text></View>
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
      min_qty_alert: String(item.min_qty_alert ?? 0),
      reorder_to: item.reorder_to != null ? String(item.reorder_to) : '',
    });
    setEditCategory(item.category ?? '');
    setEditReturnable(item.returnable === 1);
    setEditUnitTracked(item.unit_tracked === 1);
    setEditTagPrefix(item.tag_prefix ?? '');
    setEditing(true);
  }

  function saveEdit() {
    if (!item) return;
    if (!form.name?.trim()) { Alert.alert('Required', 'Item name is required.'); return; }
    const fields = {
      name: form.name.trim(),
      model: form.model.trim() || null,
      description: form.description.trim() || null,
      barcode: form.barcode.trim() || null,
      sku: form.sku.trim() || null,
      supplier: form.supplier.trim() || null,
      min_qty_alert: parseFloat(form.min_qty_alert) || 0,
      reorder_to: form.reorder_to.trim() ? parseFloat(form.reorder_to) : null,
      category: editCategory.trim() || null,
      returnable: (editReturnable ? 1 : 0) as number,
      unit_tracked: (editUnitTracked ? 1 : 0) as number,
      tag_prefix: editTagPrefix.trim() || null,
    };
    const synced = updateItemFields(item.id, fields);
    // Outbox: send returnable + unit_tracked as real booleans (Postgres columns are BOOLEAN)
    appendOutbox('UPDATE', 'inventory_items', { ...synced, returnable: editReturnable, unit_tracked: editUnitTracked });
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
  function doRepairOut(unit: EquipmentUnit, note: string) {
    if (!user || !item) return;
    const updated = setUnitStatus(unit.id, { status: 'in_repair', notes: note.trim() || null });
    appendOutbox('UPDATE', 'equipment_units', {
      id: updated.id, item_id: updated.item_id, asset_tag: updated.asset_tag,
      serial_number: updated.serial_number, status: updated.status,
      current_location_id: updated.current_location_id, current_job_id: updated.current_job_id,
      notes: updated.notes, created_at: updated.created_at, updated_at: updated.updated_at,
      // synced_at intentionally omitted
    });
    appendLog({
      user_id: user.id, team_id: null, action: 'repair_out',
      entity_type: 'item', entity_id: item.id,
      from_location_id: null, to_location_id: null, quantity: null, unit: null, job_id: null,
      note: 'unit ' + unit.asset_tag + (note.trim() ? ': ' + note.trim() : ''),
      metadata: null, device_id: null,
    });
    setRepairOutUnit(null);
    setRepairNote('');
    reload();
  }

  function doRepairIn(unit: EquipmentUnit, locationId: string) {
    if (!user || !item) return;
    const updated = setUnitStatus(unit.id, { status: 'available', current_location_id: locationId, notes: null });
    appendOutbox('UPDATE', 'equipment_units', {
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
    setRepairInUnit(null);
    setRepairInLoc(null);
    reload();
  }

  const cat = item.unit_category as UnitCategory;

  return (
    <>
      <Stack.Screen options={{ title: editing ? 'Edit Item' : item.name, headerShown: true }} />
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
                placeholder="Air Movers, Filters, Equipment Inventory…"
              />
              <View style={s.switchRow}>
                <Text style={s.switchLabel}>Returnable? (expected back via Check In)</Text>
                <Switch value={editReturnable} onValueChange={setEditReturnable} />
              </View>
              {item.kind === 'equipment' && (
                <>
                  <View style={s.switchRow}>
                    <Text style={s.switchLabel}>Track individual units</Text>
                    <Switch value={editUnitTracked} onValueChange={setEditUnitTracked} />
                  </View>
                  {editUnitTracked && (
                    <TextInput
                      style={s.input}
                      placeholder="Tag prefix (AM-, DH-, MSC-…)"
                      placeholderTextColor="#94A3B8"
                      value={editTagPrefix}
                      onChangeText={setEditTagPrefix}
                      autoCapitalize="characters"
                    />
                  )}
                  <Text style={s.unitReadOnly}>Unit: each (piece) — fixed for equipment</Text>
                </>
              )}
              <Field label="Low-stock alert" value={form.min_qty_alert} onChange={setField('min_qty_alert')} keyboardType="decimal-pad" />
              <Field label="Reorder up to" value={form.reorder_to} onChange={setField('reorder_to')} keyboardType="decimal-pad" />

              <View style={s.row}>
                <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={() => setEditing(false)}>
                  <Text style={s.btnGhostText}>Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={saveEdit}>
                  <Text style={s.btnPrimaryText}>Save Changes</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <>
              <View style={s.card}>
                <Text style={s.name}>{item.name}</Text>
                {!!item.model && <Text style={s.model}>{item.model}</Text>}
                {!!item.description && <Text style={s.desc}>{item.description}</Text>}
                <View style={s.totalRow}>
                  <Text style={s.totalNum}>{formatQuantity(total, item.unit, cat)}</Text>
                  <Text style={s.totalLbl}>on hand</Text>
                </View>
                {item.min_qty_alert > 0 && total <= item.min_qty_alert && (
                  <Text style={s.lowStock}>⚠ Low stock — at or below alert of {item.min_qty_alert}</Text>
                )}
              </View>

              <View style={s.card}>
                {!!item.category && <Row k="Category" v={item.category} />}
                <Row k="Unit Type" v={UNIT_CATEGORY_LABELS[cat]} />
                <Row k="Unit" v={item.unit} />
                <Row k="Barcode" v={item.barcode ?? '—'} />
                <Row k="SKU / Part #" v={item.sku ?? '—'} />
                <Row k="Supplier" v={item.supplier ?? '—'} />
                <Row k="Low-stock alert" v={item.min_qty_alert > 0 ? String(item.min_qty_alert) : 'Off'} />
                <Row k="Reorder up to" v={item.reorder_to != null ? String(item.reorder_to) : '—'} />
                <View style={[s.attrRow, (item.kind === 'equipment' && !!item.unit_tracked) ? s.divider : undefined]}>
                  <Text style={s.attrKey}>Returnable</Text>
                  <View style={[s.badge, item.returnable ? s.badgeReturn : s.badgeConsume]}>
                    <Text style={[s.badgeText, item.returnable ? s.badgeReturnText : s.badgeConsumeText]}>
                      {item.returnable ? 'Returnable' : 'Consumed'}
                    </Text>
                  </View>
                </View>
                {item.kind === 'equipment' && !!item.unit_tracked && (
                  <View style={s.attrRow}>
                    <Text style={s.attrKey}>Unit tracking</Text>
                    <View style={[s.badge, s.badgeTracked]}>
                      <Text style={[s.badgeText, s.badgeTrackedText]}>
                        Individually tracked{item.tag_prefix ? ` · ${item.tag_prefix}` : ''}
                      </Text>
                    </View>
                  </View>
                )}
              </View>

              {item.unit_tracked === 1 ? (
                <>
                  <Text style={s.sectionLabel}>Units on Hand</Text>
                  <View style={s.card}>
                    <Text style={s.unitSummary}>
                      {unitCounts.available} available
                      {unitCounts.deployed > 0 ? ` · ${unitCounts.deployed} deployed` : ''}
                      {unitCounts.in_repair > 0 ? ` · ${unitCounts.in_repair} in repair` : ''}
                    </Text>
                    {availableByLocation.length > 0 && (
                      <View style={{ marginTop: 10 }}>
                        {availableByLocation.map((loc, i) => (
                          <View key={loc.locationId} style={[s.stockRow, i < availableByLocation.length - 1 && s.divider]}>
                            <Text style={s.stockLoc}>{loc.locationName}</Text>
                            <Text style={s.stockQty}>{loc.count} available</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </View>
                </>
              ) : (
                <>
                  <Text style={s.sectionLabel}>Stock by location</Text>
                  <View style={s.card}>
                    {stock.length === 0 ? (
                      <Text style={s.muted}>No stock recorded yet.</Text>
                    ) : (
                      stock.map((row, i) => (
                        <View key={row.location_id} style={[s.stockRow, i < stock.length - 1 && s.divider]}>
                          <View style={{ flex: 1 }}>
                            <Text style={s.stockLoc}>{row.location_name}</Text>
                            {!!row.parent_name && <Text style={s.stockParent}>{row.parent_name}</Text>}
                          </View>
                          <Text style={[s.stockQty, row.quantity === 0 && s.stockZero]}>
                            {formatQuantity(row.quantity, item.unit, cat)}
                          </Text>
                        </View>
                      ))
                    )}
                  </View>
                </>
              )}

              {item.unit_tracked === 1 && (
                <>
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
                            onRepairOut={
                              canEdit && (u.status === 'available' || u.status === 'deployed')
                                ? () => { setRepairOutUnit(u); setRepairNote(''); }
                                : undefined
                            }
                            onRepairIn={
                              canEdit && u.status === 'in_repair'
                                ? () => { setRepairInUnit(u); setRepairInLoc(null); }
                                : undefined
                            }
                          />
                        </View>
                      ))
                    )}
                  </View>
                  {canAddUnits && (
                    <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={openAddUnits}>
                      <Text style={s.btnPrimaryText}>+ Add Units</Text>
                    </TouchableOpacity>
                  )}
                </>
              )}

              <Text style={s.sectionLabel}>Photos</Text>
              <MediaGallery entityType="item" entityId={id} canUpload={canUpload} />

              {canEdit && (
                <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={startEdit}>
                  <Text style={s.btnPrimaryText}>Edit Item</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Repair-Out Modal (note prompt) ─────────────────────────────── */}
      <Modal
        visible={repairOutUnit !== null}
        transparent
        animationType="fade"
        onRequestClose={() => { setRepairOutUnit(null); setRepairNote(''); }}
      >
        <View style={s.overlay}>
          <View style={s.promptCard}>
            <Text style={s.promptTitle}>Send to Repair</Text>
            <Text style={s.promptSub}>{repairOutUnit?.asset_tag}</Text>
            <TextInput
              style={[s.input, { marginTop: 12 }]}
              placeholder="Note (optional)"
              placeholderTextColor="#94A3B8"
              value={repairNote}
              onChangeText={setRepairNote}
              autoFocus
            />
            <View style={[s.row, { marginTop: 16 }]}>
              <TouchableOpacity
                style={[s.btn, s.btnGhost]}
                onPress={() => { setRepairOutUnit(null); setRepairNote(''); }}
              >
                <Text style={s.btnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.btn, s.btnPrimary]}
                onPress={() => repairOutUnit && doRepairOut(repairOutUnit, repairNote)}
              >
                <Text style={s.btnPrimaryText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* ── Repair-In Modal (location picker) ──────────────────────────── */}
      <Modal
        visible={repairInUnit !== null}
        animationType="slide"
        onRequestClose={() => { setRepairInUnit(null); setRepairInLoc(null); }}
      >
        <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>Return from Repair — {repairInUnit?.asset_tag}</Text>
              <TouchableOpacity onPress={() => { setRepairInUnit(null); setRepairInLoc(null); }}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={s.fieldLabel}>Return to Location *</Text>
            <SearchablePicker
              placeholder="Search location…"
              options={locationOptions}
              value={repairInLoc}
              onSelect={(opt) => {
                if (repairInLoc !== null) setRepairInLoc(null);
                else setRepairInLoc(opt);
              }}
            />
            <View style={[s.row, { marginTop: 16 }]}>
              <TouchableOpacity
                style={[s.btn, s.btnGhost]}
                onPress={() => { setRepairInUnit(null); setRepairInLoc(null); }}
              >
                <Text style={s.btnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.btn, s.btnPrimary]}
                onPress={() => {
                  if (!repairInLoc) { Alert.alert('Required', 'Please select a location.'); return; }
                  if (repairInUnit) doRepairIn(repairInUnit, repairInLoc.id);
                }}
              >
                <Text style={s.btnPrimaryText}>Confirm Return</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>

      {/* ── Add Units Modal ────────────────────────────────────────────── */}
      <Modal visible={addUnitsOpen} animationType="slide" onRequestClose={closeAddUnits}>
        <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
            <View style={s.modalHeader}>
              <Text style={s.modalTitle}>Add Units — {item.name}</Text>
              <TouchableOpacity onPress={closeAddUnits}>
                <Text style={s.modalClose}>✕</Text>
              </TouchableOpacity>
            </View>

            <Text style={s.fieldLabel}>Location *</Text>
            <SearchablePicker
              placeholder="Search location…"
              options={locationOptions}
              value={addUnitsLoc}
              onSelect={(opt) => {
                if (addUnitsLoc !== null) setAddUnitsLoc(null);
                else setAddUnitsLoc(opt);
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
                <View style={{ marginTop: 10 }}>
                  <Text style={s.fieldLabel}>Serial # (optional)</Text>
                  <TextInput
                    style={s.input}
                    value={row.serial}
                    onChangeText={(v) => updateSerial(i, v)}
                    placeholder="Serial number"
                    placeholderTextColor="#94A3B8"
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>
              </View>
            ))}

            <TouchableOpacity style={[s.btn, s.btnGhost, { marginTop: 4 }]} onPress={addUnitRow}>
              <Text style={s.btnGhostText}>+ Add another</Text>
            </TouchableOpacity>

            <View style={s.row}>
              <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={closeAddUnits}>
                <Text style={s.btnGhostText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={saveUnits}>
                <Text style={s.btnPrimaryText}>Save Units</Text>
              </TouchableOpacity>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </>
  );
}

function Row({ k, v, last }: { k: string; v: string; last?: boolean }) {
  return (
    <View style={[s.attrRow, !last && s.divider]}>
      <Text style={s.attrKey}>{k}</Text>
      <Text style={s.attrVal}>{v}</Text>
    </View>
  );
}

function Field(props: {
  label: string; value: string; onChange: (v: string) => void;
  multiline?: boolean; keyboardType?: 'decimal-pad'; autoCapitalize?: 'none' | 'characters'; autoFocus?: boolean;
}) {
  return (
    <View style={s.fieldWrap}>
      <Text style={s.fieldLabel}>{props.label}</Text>
      <TextInput
        style={[s.input, props.multiline && s.multiline]}
        value={props.value}
        onChangeText={props.onChange}
        multiline={props.multiline}
        keyboardType={props.keyboardType}
        autoCapitalize={props.autoCapitalize}
        autoFocus={props.autoFocus}
        placeholderTextColor="#94A3B8"
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF' },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 14, color: '#94A3B8' },
  card: { backgroundColor: '#fff', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#EEF2F7' },
  name: { fontSize: 22, fontWeight: '700', color: '#1E3A5F' },
  model: { fontSize: 14, color: '#2563EB', marginTop: 2, fontWeight: '600' },
  desc: { fontSize: 14, color: '#475569', marginTop: 8, lineHeight: 20 },
  totalRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 14 },
  totalNum: { fontSize: 26, fontWeight: '800', color: '#0F172A' },
  totalLbl: { fontSize: 13, color: '#64748B' },
  lowStock: { marginTop: 8, color: '#B91C1C', fontSize: 13, fontWeight: '600' },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  attrRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11 },
  attrKey: { fontSize: 14, color: '#64748B' },
  attrVal: { fontSize: 14, color: '#1E293B', fontWeight: '600', maxWidth: '60%', textAlign: 'right' },
  divider: { borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  stockRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  stockLoc: { fontSize: 15, color: '#1E293B', fontWeight: '600' },
  stockParent: { fontSize: 12, color: '#94A3B8', marginTop: 1 },
  stockQty: { fontSize: 15, fontWeight: '700', color: '#15803D' },
  stockZero: { color: '#CBD5E1' },
  fieldWrap: { gap: 6 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 0.5 },
  input: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0', paddingHorizontal: 14, height: 44, fontSize: 14, color: '#1E293B' },
  multiline: { height: 80, paddingTop: 12, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 12, marginTop: 16 },
  btn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 8, flex: 1 },
  btnPrimary: { backgroundColor: '#2563EB' },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  btnGhost: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#CBD5E1' },
  btnGhostText: { color: '#475569', fontWeight: '600', fontSize: 16 },
  badge: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  badgeReturn: { backgroundColor: '#D1FAE5' },
  badgeReturnText: { color: '#065F46', fontWeight: '700', fontSize: 13 },
  badgeConsume: { backgroundColor: '#FEE2E2' },
  badgeConsumeText: { color: '#991B1B', fontWeight: '700', fontSize: 13 },
  badgeText: { fontSize: 13, fontWeight: '700' },
  badgeTracked: { backgroundColor: '#DBEAFE' },
  badgeTrackedText: { color: '#1D4ED8', fontWeight: '700', fontSize: 13 },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#E2E8F0',
    paddingHorizontal: 14, paddingVertical: 10,
  },
  switchLabel: { fontSize: 14, color: '#1E293B', flex: 1, marginRight: 12 },
  unitReadOnly: {
    fontSize: 13, color: '#64748B', fontStyle: 'italic',
    paddingVertical: 4, paddingHorizontal: 4,
  },
  unitRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  unitTag: { fontSize: 15, color: '#1E293B', fontWeight: '600' },
  unitSerial: { fontSize: 12, color: '#94A3B8', marginTop: 1 },
  modalHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 8,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#1E3A5F', flex: 1, marginRight: 8 },
  modalClose: { fontSize: 22, color: '#64748B', paddingHorizontal: 4 },
  unitFormCard: {
    backgroundColor: '#fff', borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: '#EEF2F7', gap: 0,
  },
  unitSummary: { fontSize: 15, fontWeight: '600', color: '#1E293B' },
  overlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center', padding: 24,
  },
  promptCard: {
    backgroundColor: '#fff', borderRadius: 16, padding: 20,
    width: '100%', maxWidth: 360,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 6,
  },
  promptTitle: { fontSize: 17, fontWeight: '700', color: '#1E3A5F' },
  promptSub: { fontSize: 14, color: '#64748B', marginTop: 2 },
});
