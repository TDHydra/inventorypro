import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import {
  Alert, useThemedStyles, PrimaryButton, FieldLabel, FilterChip,
  TextField, SelectField, QuantityStepper, ModalSheet, StatusPill, AppInput,
  FormScreen, SuggestInput,
} from '@invenpro/ui';
import { parseOptionalCount, parsePackSize, validateName, validateText, MAX_QUANTITY } from '../../../src/lib/validation';
import { track } from '../../../src/telemetry';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getItemById, getStockByItem, updateItemFields, getDistinctValues, adjustStock,
  type InventoryItem, type StockByLocation,
} from '../../../src/repos/items';
import { getLocationPath, resolveLocationShelfSelection } from '../../../src/repos/locations';
import { appendLog } from '../../../src/db/queries/log';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import { UnitCategory, formatQuantity, PRODUCT_CLASS_IDS, getUnitsForClass } from '../../../src/constants/units';
import { getProductClassById, getProductClasses, getItemTypes, parseItemTypeMeta, type TaxonomyType, getItemTypeColorMap } from '../../../src/repos/taxonomy';
import { resolveTypeColor } from '@invenpro/ui';
import { BarcodeInput } from '../../../src/components/BarcodeInput';
import { AutofillTextField } from '../../../src/components/ui/AutofillTextField';
import type { Theme } from '@invenpro/ui';
import { LocationShelfPicker } from '../../../src/components/pickers';
import type { PickerOption } from '../../../src/components/SearchablePicker';
import MoveStockModal from '../../../src/components/MoveStockModal';
import { RequestApprovalSheet } from '../../../src/components/RequestApprovalSheet';

// Audit a validation rejection — field path + rule name ONLY, never the value.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'item_detail', props: { field, rule } });
}

export default function ItemDetailScreen() {
  const s = useThemedStyles(makeStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const canEdit = usePermission('edit_inventory');
  const { realUser } = useSession();
  const { locked } = useMaintenanceMode();
  const refreshKey = useFocusOrDataRefresh();

  const [item, setItem] = useState<InventoryItem | null>(() => getItemById(id));
  const [stock, setStock] = useState<StockByLocation[]>(() => getStockByItem(id));
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});
  // Edit-mode state for fields outside the string-keyed form record
  const [editCategory, setEditCategory] = useState('');
  const [editReturnable, setEditReturnable] = useState(false);
  // Item-type / units edit-mode state. editItemType is the selected item_category
  // label ('' = none highlighted). editUnitCat stays a real product_class id so
  // formatQuantity decimals stay correct; editUnit is the chosen unit string.
  const [editItemType, setEditItemType] = useState('');
  const [editUnitCat, setEditUnitCat] = useState<string>(PRODUCT_CLASS_IDS.piece);
  const [editUnit, setEditUnit] = useState('');
  // 0 = off (QuantityStepper has no blank state; mirrors the add-screen convention).
  const [editMinAlert, setEditMinAlert] = useState(0);
  // #248: auto-dirty cadence for this item's units. 0 = off in the UI
  // (QuantityStepper convention, same as editMinAlert) but writes NULL at the
  // save boundary — clean_after_jobs is nullable, unlike min_qty_alert.
  const [editCleanAfterJobs, setEditCleanAfterJobs] = useState(0);
  // Optional "home" location (where the item belongs). Nullable. The two-stage
  // LocationShelfPicker holds the parent location and its optional shelf
  // separately; both are resolved to a single id at submit.
  const [editHomeLocation, setEditHomeLocation] = useState<PickerOption | null>(null);
  const [editHomeShelf, setEditHomeShelf] = useState<PickerOption | null>(null);

  // Admin-managed Item Types (PPE, Filters, …) and product classes (unit class
  // override). Each item type carries its curated units + unit class in meta.
  const itemTypes = useMemo(() => getItemTypes(), [refreshKey]);
  // Item Types are a managed taxonomy → an admin can override the auto color.
  // Keyed on refreshKey so the map refreshes after a sync.
  const itemTypeColorMap = useMemo(() => getItemTypeColorMap(), [refreshKey]);
  const productClasses = useMemo(() => getProductClasses(), [refreshKey]);

  const categoryOptions = useMemo(() => getDistinctValues('category'), [refreshKey]);
  const unitDbOptions = useMemo(() => getDistinctValues('unit'), [refreshKey]);

  const total = useMemo(
    () => stock.reduce((sum, st) => sum + st.quantity, 0),
    [stock]
  );

  const reload = useCallback(() => {
    setItem(getItemById(id));
    setStock(getStockByItem(id));
  }, [id]);

  // Re-read item + stock on refocus and on sync-pull bumps (refreshKey), so the
  // detail view tracks changes made elsewhere. Edit-mode buffers (form/edit*)
  // are seeded once in startEdit and are NOT reseeded here — in-progress edits
  // survive a background pull.
  useEffect(() => { reload(); }, [reload, refreshKey]);

  // Equipment items are managed in the Equipment tab — redirect immediately
  useEffect(() => {
    if (item?.kind === 'equipment') {
      router.replace({ pathname: '/(app)/equipment/[id]', params: { id } });
    }
  }, [item?.kind, id, router]);

  // ── Stock section: per-location adjust (+/- delta via adjustStock) and move
  // (via the existing MoveStockModal). Neither flow existed in the old app's
  // item detail screen — the old app's per-location adjust lived only in the
  // location detail screen / quick-add; consolidating both into the item detail
  // view is new for the lean rebuild so an item's stock is fully manageable from
  // one place. ──────────────────────────────────────────────────────────────
  const [adjustTarget, setAdjustTarget] = useState<{ locationId: string; locationName: string } | null>(null);
  const [adjustDeltaText, setAdjustDeltaText] = useState('');
  const [moveFrom, setMoveFrom] = useState<{ locationId: string; locationName: string } | null>(null);
  const [addStockOpen, setAddStockOpen] = useState(false);
  const [requestApprovalOpen, setRequestApprovalOpen] = useState(false);
  const [addLoc, setAddLoc] = useState<PickerOption | null>(null);
  const [addShelf, setAddShelf] = useState<PickerOption | null>(null);
  const [addQtyText, setAddQtyText] = useState('');

  function openAdjust(locationId: string, locationName: string) {
    setAdjustDeltaText('');
    setAdjustTarget({ locationId, locationName });
  }

  function submitAdjust() {
    if (!item || !adjustTarget) return;
    if (isWriteBlocked()) return;
    const delta = parseFloat(adjustDeltaText);
    if (!Number.isFinite(delta) || delta === 0) {
      trackReject('stock.delta', 'invalid');
      Alert.alert('Invalid amount', 'Enter a non-zero number (negative to remove stock).');
      return;
    }
    adjustStock(item.id, adjustTarget.locationId, delta);
    appendLog({
      action: 'adjust_stock', entity_type: 'item', entity_id: item.id,
      to_location_id: adjustTarget.locationId, from_location_id: null,
      quantity: delta, unit: item.unit, user_id: realUser?.id ?? null, team_id: null,
      job_id: null, note: null, metadata: null, device_id: null,
    });
    setAdjustTarget(null);
    setAdjustDeltaText('');
    reload();
  }

  function submitAddStock() {
    if (!item) return;
    if (isWriteBlocked()) return;
    if (!addLoc) {
      trackReject('stock.location', 'required');
      Alert.alert('Required', 'Select a location.');
      return;
    }
    const qty = parseFloat(addQtyText);
    if (!Number.isFinite(qty) || qty <= 0) {
      trackReject('stock.qty', 'invalid');
      Alert.alert('Invalid quantity', 'Enter a quantity greater than 0.');
      return;
    }
    const resolved = resolveLocationShelfSelection(addLoc, addShelf);
    if (!resolved.ok) {
      Alert.alert('Couldn’t add that location', `Could not create shelf “${resolved.shelfLabel}”. Please try again.`);
      return;
    }
    if (!resolved.id) {
      trackReject('stock.location', 'required');
      Alert.alert('Required', 'Select a location.');
      return;
    }
    const destLocationId = resolved.id;
    adjustStock(item.id, destLocationId, qty);
    appendLog({
      action: 'adjust_stock', entity_type: 'item', entity_id: item.id,
      to_location_id: destLocationId, from_location_id: null,
      quantity: qty, unit: item.unit, user_id: realUser?.id ?? null, team_id: null,
      job_id: null, note: null, metadata: null, device_id: null,
    });
    setAddStockOpen(false);
    setAddLoc(null);
    setAddShelf(null);
    setAddQtyText('');
    reload();
  }

  if (!item) {
    return (
      <>
        <Stack.Screen options={{ title: 'Item', headerShown: true }} />
        <View style={s.center}><Text style={s.muted}>Item not found.</Text></View>
      </>
    );
  }

  // Don't render product UI while the redirect to the Equipment tab is in flight
  if (item.kind === 'equipment') {
    return (
      <>
        <Stack.Screen options={{ title: 'Equipment', headerShown: true }} />
        <View style={s.center}><Text style={s.muted}>Opening in Equipment…</Text></View>
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
      reorder_to: item.reorder_to != null ? String(item.reorder_to) : '',
      pack_size: item.pack_size != null ? String(item.pack_size) : '',
    });
    setEditMinAlert(item.min_qty_alert ?? 0);
    setEditCleanAfterJobs(item.clean_after_jobs ?? 0);
    setEditCategory(item.category ?? '');
    setEditReturnable(item.returnable === 1);
    // Seed units from the item as-is (data safety: never destroy an existing
    // unit_category/unit). Preselect the item type only when the current
    // category matches a known type — otherwise leave none highlighted and keep
    // the existing class/unit untouched until the user actually picks a type.
    setEditUnitCat(item.unit_category || PRODUCT_CLASS_IDS.piece);
    setEditUnit(item.unit ?? '');
    const matched = itemTypes.find(t => t.label === item.category);
    setEditItemType(matched ? matched.label : '');
    // Seed the home-location picker from the stored id (resolved to its path).
    setEditHomeLocation(
      item.home_location_id
        ? { id: item.home_location_id, label: getLocationPath(item.home_location_id) }
        : null,
    );
    setEditHomeShelf(null);
    setEditing(true);
  }

  // Pick/clear an item type — selecting one auto-sets the unit class + units +
  // category to whatever that type allows (mirrors quick-add). Tapping the
  // selected type again clears back to the default piece class.
  function selectItemType(t: TaxonomyType) {
    if (editItemType === t.label) {
      setEditItemType('');
      setEditCategory('');
      setEditUnitCat(PRODUCT_CLASS_IDS.piece);
      setEditUnit(getUnitsForClass(PRODUCT_CLASS_IDS.piece)[0] ?? 'each');
      return;
    }
    const m = parseItemTypeMeta(t.meta);
    const cls = m.classId ?? PRODUCT_CLASS_IDS.piece;
    const opts = m.units.length > 0 ? m.units : getUnitsForClass(cls);
    setEditItemType(t.label);
    setEditCategory(t.label);
    setEditUnitCat(cls);
    setEditUnit(opts[0] ?? '');
  }

  // Manual unit-class override — breaks the item-type linkage (the type's class
  // may differ) but keeps the free-text category intact.
  function selectUnitClass(classId: string) {
    setEditUnitCat(classId);
    setEditItemType('');
    const opts = getUnitsForClass(classId);
    setEditUnit(opts[0] ?? '');
  }

  function saveEdit() {
    if (!item) return;
    // Bounded, control-char-free name (same 'Item name is required.' copy as
    // before for the blank case).
    const nameResult = validateName(form.name ?? '', { label: 'Item name' });
    if (!nameResult.ok) { trackReject('item.name', nameResult.rule); Alert.alert('Required', nameResult.error); return; }

    // Optional free text: bounded + control-char-rejecting, checked BEFORE any
    // local write. Blank stays fine (→ null below, as before).
    const textChecks = [
      { field: 'item.model', value: form.model ?? '', label: 'Color / Model', max: 200 },
      { field: 'item.description', value: form.description ?? '', label: 'Description', max: 2000 },
      { field: 'item.barcode', value: form.barcode ?? '', label: 'Barcode', max: 512 },
      { field: 'item.sku', value: form.sku ?? '', label: 'SKU / Part #', max: 100 },
      { field: 'item.supplier', value: form.supplier ?? '', label: 'Supplier / Vendor', max: 200 },
      { field: 'item.category', value: editCategory, label: 'Category', max: 200 },
      { field: 'item.unit', value: editUnit, label: 'Unit', max: 40 },
    ] as const;
    for (const c of textChecks) {
      const r = validateText(c.value, { label: c.label, max: c.max });
      if (!r.ok) { trackReject(c.field, r.rule); Alert.alert(`Invalid ${c.label.toLowerCase()}`, r.error); return; }
    }

    // Validate numeric fields up front with clear, fixable messages (mirrors the
    // add/quick-add screens) instead of silently coercing bad input.
    const reorder = parseOptionalCount(form.reorder_to, 'Reorder up to');
    if (!reorder.ok) { trackReject('item.reorder_to', reorder.rule); Alert.alert('Invalid reorder amount', reorder.error); return; }
    const pack = parsePackSize(form.pack_size ?? '');
    if (!pack.ok) { trackReject('item.pack_size', pack.rule); Alert.alert('Invalid pack size', pack.error); return; }

    // Resolve the (location, shelf) pair into the single home-location id BEFORE
    // building the update so a failed shelf create can't silently drop it.
    const locRes = resolveLocationShelfSelection(editHomeLocation, editHomeShelf);
    if (!locRes.ok) {
      Alert.alert('Couldn’t add that location', `Could not create shelf “${locRes.shelfLabel}”. Please try again.`);
      return;
    }
    const homeLocationId = locRes.id;

    updateItemFields(item.id, {
      name: form.name.trim(),
      model: form.model.trim() || null,
      description: form.description.trim() || null,
      barcode: form.barcode.trim() || null,
      sku: form.sku.trim() || null,
      supplier: form.supplier.trim() || null,
      min_qty_alert: editMinAlert,
      reorder_to: reorder.value,
      // 0 -> NULL at the write boundary (min_qty_alert convention, but
      // clean_after_jobs is nullable so NULL, not 0, is the canonical "off").
      clean_after_jobs: editCleanAfterJobs > 0 ? editCleanAfterJobs : null,
      category: editCategory.trim() || null,
      returnable: (editReturnable ? 1 : 0) as number,
      // Keep unit_category a real product_class id so formatQuantity decimals
      // stay correct; never write an empty unit (fall back to the existing one).
      unit_category: editUnitCat || PRODUCT_CLASS_IDS.piece,
      unit: editUnit.trim() || item.unit,
      home_location_id: homeLocationId,
      pack_size: pack.value,
    });
    setEditing(false);
    reload();
  }

  // #248: standalone item-level "needs cleaning" toggle — no confirm (mirrors
  // the equipment unit's mark clean/dirty toggle), logged against its own two
  // activity actions (not folded into the generic 'item_updated' save above).
  function toggleNeedsCleaning() {
    if (!item) return;
    if (isWriteBlocked()) return;
    const next = !item.needs_cleaning;
    updateItemFields(item.id, { needs_cleaning: (next ? 1 : 0) as number });
    appendLog({
      user_id: realUser?.id ?? null,
      team_id: null,
      action: next ? 'item_marked_needs_cleaning' : 'item_marked_clean',
      entity_type: 'item',
      entity_id: item.id,
      from_location_id: null,
      to_location_id: null,
      quantity: null,
      unit: null,
      job_id: null,
      note: null,
      metadata: null,
      device_id: null,
    });
    reload();
  }

  const setField = (k: string) => (v: string) => setForm(f => ({ ...f, [k]: v }));

  const cat = item.unit_category as UnitCategory;

  // Unit options for the edit-mode picker: the selected item type's curated
  // units, else the chosen unit class's units. Always include the current
  // editUnit so an existing (possibly custom/legacy) unit stays visible and
  // selected rather than being silently dropped.
  const selectedEditType = itemTypes.find(t => t.label === editItemType) ?? null;
  const editTypeUnits = selectedEditType ? parseItemTypeMeta(selectedEditType.meta).units : [];
  const editBaseUnits = editTypeUnits.length > 0 ? editTypeUnits : getUnitsForClass(editUnitCat);
  const editUnitOptions = editUnit && !editBaseUnits.includes(editUnit)
    ? [editUnit, ...editBaseUnits]
    : editBaseUnits;
  // Merge in every unit ever typed anywhere in the catalog (deduped, curated/
  // current-value options first) so a legacy/custom unit stays reachable —
  // mirrors the add-screen's unit picker.
  const mergedEditUnitOptions = (() => {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const u of editUnitOptions) if (!seen.has(u)) { seen.add(u); merged.push(u); }
    for (const u of unitDbOptions) if (!seen.has(u)) { seen.add(u); merged.push(u); }
    return merged;
  })();

  return (
    <>
      <Stack.Screen options={{ title: editing ? 'Edit Item' : item.name, headerShown: true }} />
      <FormScreen contentContainerStyle={s.content}>
          {editing ? (
            <>
              <TextField label="Name" required value={form.name} onChangeText={setField('name')} autoFocus />
              <AutofillTextField label="Color / Model" table="inventory_items" column="model" value={form.model} onChangeText={setField('model')} />
              <TextField label="Description" value={form.description} onChangeText={setField('description')} multiline />
              <BarcodeInput label="Barcode" value={form.barcode} onChange={setField('barcode')} />
              <TextField label="SKU / Part #" value={form.sku} onChangeText={setField('sku')} autoCapitalize="characters" />
              <AutofillTextField label="Supplier / Vendor" table="inventory_items" column="supplier" value={form.supplier} onChangeText={setField('supplier')} />
              <View style={s.fieldWrap}>
                <FieldLabel>Home location (where it belongs)</FieldLabel>
                <LocationShelfPicker
                  locationValue={editHomeLocation}
                  shelfValue={editHomeShelf}
                  onChangeLocation={setEditHomeLocation}
                  onChangeShelf={setEditHomeShelf}
                />
              </View>
              {itemTypes.length > 0 && (
                <View style={s.fieldWrap}>
                  <FieldLabel>Item type</FieldLabel>
                  <View style={s.chipRow}>
                    {itemTypes.map(t => (
                      <View key={t.id} style={s.chipWithDot}>
                        <View style={[s.typeDot, { backgroundColor: resolveTypeColor(t.label, itemTypeColorMap[t.label]) }]} />
                        <FilterChip
                          label={t.icon ? `${t.icon} ${t.label}` : t.label}
                          active={editItemType === t.label}
                          onPress={() => selectItemType(t)}
                        />
                      </View>
                    ))}
                  </View>
                </View>
              )}
              <SuggestInput
                label="Category"
                value={editCategory}
                // Keep the Item Type chip highlight in sync with the typed
                // category so the two inputs can't diverge (typing a non-type
                // category clears the highlight; typing a type's name selects it).
                onChange={(v) => {
                  setEditCategory(v);
                  setEditItemType(itemTypes.find(t => t.label === v)?.label ?? '');
                }}
                suggestions={categoryOptions}
                placeholder="Air Movers, Filters, Equipment Inventory…"
              />
              {productClasses.length > 0 && (
                <View style={s.fieldWrap}>
                  <FieldLabel>Unit type (override)</FieldLabel>
                  <View style={s.chipRow}>
                    {productClasses.map(c => (
                      <FilterChip
                        key={c.id}
                        label={c.icon ? `${c.icon} ${c.label}` : c.label}
                        active={editUnitCat === c.id}
                        onPress={() => selectUnitClass(c.id)}
                      />
                    ))}
                  </View>
                </View>
              )}
              {/* Parity with the pre-refactor chips+input: a picker for known
                  units PLUS an always-present free-text fallback for a new/
                  custom one. */}
              {mergedEditUnitOptions.length > 0 && (
                <SelectField
                  label="Unit"
                  value={editUnit || null}
                  options={mergedEditUnitOptions.map(u => ({ id: u, label: u }))}
                  onSelect={setEditUnit}
                  recentKey="unit"
                />
              )}
              <TextField label="Custom unit" value={editUnit} onChangeText={setEditUnit} placeholder="Unit (e.g. each)" autoCapitalize="none" />
              <View style={s.switchRow}>
                <Text style={s.switchLabel}>Returnable? (expected back via Check In)</Text>
                <Switch value={editReturnable} onValueChange={setEditReturnable} />
              </View>
              <QuantityStepper label="Low-stock alert (0 = off)" value={editMinAlert} onChange={setEditMinAlert} min={0} max={MAX_QUANTITY} />
              {/* #248: auto-dirty cadence — every Nth job check-in flips a clean
                  unit of this item to dirty. 0 = off, same convention as the
                  low-stock alert above. */}
              <QuantityStepper label="Clean after N jobs (0 = off)" value={editCleanAfterJobs} onChange={setEditCleanAfterJobs} min={0} max={MAX_QUANTITY} />
              {/* Reorder up to / Pack size stay plain text fields (not
                  QuantityStepper): blank vs 0 is a meaningful distinction for
                  both. */}
              <TextField label="Reorder up to" value={form.reorder_to} onChangeText={setField('reorder_to')} keyboardType="decimal-pad" />
              <TextField label="Pack size (units per pack, optional)" value={form.pack_size ?? ''} onChangeText={setField('pack_size')} keyboardType="decimal-pad" />

              <View style={s.row}>
                <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={() => setEditing(false)}>
                  <Text style={s.btnGhostText}>Cancel</Text>
                </TouchableOpacity>
                <PrimaryButton label="Save Changes" onPress={saveEdit} style={{ flex: 1 }} />
              </View>
            </>
          ) : (
            <>
              <View style={s.card}>
                <Text style={s.name}>{item.name}</Text>
                {!!item.needs_cleaning && (
                  <View style={{ marginTop: 6, alignSelf: 'flex-start' }}>
                    <StatusPill label="Needs cleaning" tone="warning" />
                  </View>
                )}
                {!!item.model && <Text style={s.model}>{item.model}</Text>}
                {!!item.description && <Text style={s.desc}>{item.description}</Text>}
                {!!item.home_location_id && (() => {
                  const homePath = getLocationPath(item.home_location_id);
                  return (
                    <Text style={s.belongsAt}>
                      📍 Belongs at: {homePath || '(archived location)'}
                    </Text>
                  );
                })()}
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
                <Row k="Unit Type" v={getProductClassById(item.unit_category)?.label ?? item.unit_category} />
                <Row k="Unit" v={item.unit} />
                {!!item.pack_size && item.pack_size > 1 && (
                  <Row k="Pack size" v={`${item.pack_size} ${item.unit} per pack`} />
                )}
                <Row k="Barcode" v={item.barcode ?? '—'} />
                <Row k="SKU / Part #" v={item.sku ?? '—'} />
                <Row k="Supplier" v={item.supplier ?? '—'} />
                <Row k="Low-stock alert" v={item.min_qty_alert > 0 ? String(item.min_qty_alert) : 'Off'} />
                <Row k="Reorder up to" v={item.reorder_to != null ? String(item.reorder_to) : '—'} />
                <Row k="Clean after N jobs" v={item.clean_after_jobs != null && item.clean_after_jobs > 0 ? `${item.clean_after_jobs}` : 'Off'} />
                <View style={s.attrRow}>
                  <Text style={s.attrKey}>Returnable</Text>
                  <View style={[s.badge, item.returnable ? s.badgeReturn : s.badgeConsume]}>
                    <Text style={[s.badgeText, item.returnable ? s.badgeReturnText : s.badgeConsumeText]}>
                      {item.returnable ? 'Returnable' : 'Consumed'}
                    </Text>
                  </View>
                </View>
              </View>

              {canEdit && (
                <TouchableOpacity
                  style={[s.card, s.attrRow]}
                  onPress={toggleNeedsCleaning}
                  disabled={locked}
                >
                  <Text style={s.attrKey}>{item.needs_cleaning ? 'Mark clean' : 'Mark needs cleaning'}</Text>
                  <StatusPill
                    label={item.needs_cleaning ? 'Needs cleaning' : 'Clean'}
                    tone={item.needs_cleaning ? 'warning' : 'success'}
                  />
                </TouchableOpacity>
              )}

              {/* TODO(wave-labels): QR label print sheet not ported this wave —
                  no labels/printLabel.ts or LabelPrintSheet in v2 yet. */}

              <View style={s.sectionHeaderRow}>
                <Text style={s.sectionLabel}>Stock by location</Text>
                {canEdit && (
                  <TouchableOpacity onPress={() => setAddStockOpen(true)} disabled={locked}>
                    <Text style={s.sectionAction}>+ Add stock</Text>
                  </TouchableOpacity>
                )}
              </View>
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
                      {canEdit && (
                        <View style={s.stockActions}>
                          <TouchableOpacity
                            style={s.stockActionBtn}
                            disabled={locked}
                            onPress={() => openAdjust(row.location_id, row.location_name)}
                          >
                            <Text style={s.stockActionText}>Adjust</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            style={s.stockActionBtn}
                            disabled={locked}
                            onPress={() => setMoveFrom({ locationId: row.location_id, locationName: row.location_name })}
                          >
                            <Text style={s.stockActionText}>Move</Text>
                          </TouchableOpacity>
                        </View>
                      )}
                    </View>
                  ))
                )}
              </View>

              {/* TODO(wave-media): item photo gallery not ported this wave (no
                  MediaGallery/media repo in v2 yet). */}

              {/* TODO(wave-C): repairs history (PriorRepairsCard) and
                  TODO(wave-media): activity feed with media thumbnails
                  (ActivityFeed) not ported this wave — both depend on
                  modules outside this wave's ownership. */}

              {/* Request Approval — restored Station B3 (repos/approvals.ts). */}
              <PrimaryButton
                label="Request Approval"
                onPress={() => setRequestApprovalOpen(true)}
                style={{ marginBottom: canEdit ? 8 : 0 }}
              />

              {canEdit && (
                <PrimaryButton label="Edit Item" onPress={startEdit} />
              )}
            </>
          )}
      </FormScreen>

      {/* ── Adjust stock at a location (signed delta) ─────────────────────── */}
      <ModalSheet visible={adjustTarget !== null} onClose={() => setAdjustTarget(null)}>
        <Text style={s.modalTitle}>Adjust stock — {adjustTarget?.locationName}</Text>
        <FieldLabel>Amount (negative to remove)</FieldLabel>
        <AppInput
          value={adjustDeltaText}
          onChangeText={setAdjustDeltaText}
          keyboardType="numbers-and-punctuation"
          placeholder="e.g. 5 or -3"
          autoFocus
        />
        <PrimaryButton label="Apply" onPress={submitAdjust} style={{ marginTop: 12 }} />
      </ModalSheet>

      {/* ── Add stock at a new/existing location ───────────────────────────── */}
      <ModalSheet visible={addStockOpen} onClose={() => setAddStockOpen(false)}>
        <Text style={s.modalTitle}>Add stock</Text>
        <FieldLabel>Location</FieldLabel>
        <LocationShelfPicker
          locationValue={addLoc}
          shelfValue={addShelf}
          onChangeLocation={setAddLoc}
          onChangeShelf={setAddShelf}
        />
        <FieldLabel>Quantity</FieldLabel>
        <AppInput
          value={addQtyText}
          onChangeText={setAddQtyText}
          keyboardType="decimal-pad"
          placeholder="0"
        />
        <PrimaryButton label="Add" onPress={submitAddStock} style={{ marginTop: 12 }} />
      </ModalSheet>

      {/* ── Move stock out of a location (existing shared component) ──────── */}
      <MoveStockModal
        visible={moveFrom !== null}
        fromLocationId={moveFrom?.locationId ?? ''}
        fromLocationName={moveFrom?.locationName ?? ''}
        onClose={() => setMoveFrom(null)}
        onDone={() => { setMoveFrom(null); reload(); }}
      />

      {/* ── Request approval on this item (#025, restored Station B3) ─────── */}
      <RequestApprovalSheet
        visible={requestApprovalOpen}
        onClose={() => setRequestApprovalOpen(false)}
        entityType="item"
        entityId={item?.id ?? null}
        entityLabel={item?.name ?? null}
      />
    </>
  );
}

function Row({ k, v, last }: { k: string; v: string; last?: boolean }) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={[s.attrRow, !last && s.divider]}>
      <Text style={s.attrKey}>{k}</Text>
      <Text style={s.attrVal}>{v}</Text>
    </View>
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
  belongsAt: { fontSize: 13, color: t.colors.primary, marginTop: 8, fontWeight: '600' },
  totalRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 14 },
  totalNum: { fontSize: 26, fontWeight: '800', color: '#0F172A' },
  totalLbl: { fontSize: 13, color: t.colors.textSecondary },
  lowStock: { marginTop: 8, color: t.colors.danger, fontSize: 13, fontWeight: '600' },
  sectionHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: t.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
  sectionAction: { fontSize: 12, fontWeight: '700', color: t.colors.primary },
  modalTitle: { fontSize: 18, fontWeight: '700', color: t.colors.brand, marginBottom: 8 },
  attrRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11 },
  attrKey: { fontSize: 14, color: t.colors.textSecondary },
  attrVal: { fontSize: 14, color: t.colors.textPrimary, fontWeight: '600', maxWidth: '60%', textAlign: 'right' },
  divider: { borderBottomWidth: 1, borderBottomColor: t.colors.surfaceAlt },
  stockRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, flexWrap: 'wrap', gap: 8 },
  stockLoc: { fontSize: 15, color: t.colors.textPrimary, fontWeight: '600' },
  stockParent: { fontSize: 12, color: t.colors.textMuted, marginTop: 1 },
  stockQty: { fontSize: 15, fontWeight: '700', color: t.colors.success },
  stockZero: { color: t.colors.textDisabled },
  stockActions: { flexDirection: 'row', gap: 6 },
  stockActionBtn: { backgroundColor: t.colors.surfaceAlt, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  stockActionText: { fontSize: 12, fontWeight: '700', color: t.colors.primary },
  fieldWrap: { gap: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // Item-type chip + its colored type dot, grouped so they read as one unit.
  chipWithDot: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  typeDot: { width: 9, height: 9, borderRadius: 5 },
  row: { flexDirection: 'row', gap: 12, marginTop: 16 },
  btn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 8, flex: 1 },
  btnGhost: { backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.textDisabled },
  btnGhostText: { color: '#475569', fontWeight: '600', fontSize: 16 },
  badge: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  badgeReturn: { backgroundColor: t.colors.successBg },
  badgeReturnText: { color: t.colors.successText, fontWeight: '700', fontSize: 13 },
  badgeConsume: { backgroundColor: t.colors.dangerBg },
  badgeConsumeText: { color: '#991B1B', fontWeight: '700', fontSize: 13 },
  badgeText: { fontSize: 13, fontWeight: '700' },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: t.colors.surface, borderRadius: 10, borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  switchLabel: { fontSize: 14, color: t.colors.textPrimary, flex: 1, marginRight: 12 },
});
