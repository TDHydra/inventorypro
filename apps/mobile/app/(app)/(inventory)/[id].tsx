import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, KeyboardAvoidingView, Platform, Switch } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { parseOptionalCount, parsePackSize, validateName, validateText, MAX_QUANTITY } from '../../../src/lib/validation';
import { track } from '../../../src/telemetry';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getItemById, getStockByItem, updateItemFields, getDistinctValues,
  InventoryItem, StockByLocation,
} from '../../../src/db/queries/items';
import { getLocationPath, resolveLocationShelfSelection } from '../../../src/db/queries/locations';
import { appendOutbox } from '../../../src/sync/outbox';
import { usePermission } from '../../../src/hooks/usePermission';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import { UnitCategory, formatQuantity, PRODUCT_CLASS_IDS, getUnitsForClass } from '../../../src/constants/units';
import { getProductClassById, getProductClasses, getItemTypes, parseItemTypeMeta, TaxonomyType, getItemTypeColorMap } from '../../../src/db/queries/taxonomy';
import { resolveTypeColor } from '../../../src/constants/typeColors';
import { BarcodeInput } from '../../../src/components/BarcodeInput';
import { SuggestInput } from '../../../src/components/SuggestInput';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { colors } from '../../../src/theme';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { LocationShelfPicker } from '../../../src/components/pickers';
import { TextField } from '../../../src/components/ui/TextField';
import { AutofillTextField } from '../../../src/components/ui/AutofillTextField';
import { SelectField } from '../../../src/components/ui/SelectField';
import { QuantityStepper } from '../../../src/components/ui/QuantityStepper';
import type { PickerOption } from '../../../src/components/SearchablePicker';
import { LabelPrintSheet } from '../../../src/components/LabelPrintSheet';
import { RequestApprovalSheet } from '../../../src/components/RequestApprovalSheet';

// Audit a validation rejection — field path + rule name ONLY, never the value.
function trackReject(field: string, rule: string) {
  track('audit', 'validation_reject', { screen: 'item_detail', props: { field, rule } });
}

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const canEdit = usePermission('edit_inventory');
  const canUpload = usePermission('upload_media');
  const refreshKey = useFocusOrDataRefresh();

  const API = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

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

  // Label print sheet state
  const [printItemSheet, setPrintItemSheet] = useState(false);

  // Request-approval sheet state
  const [approvalOpen, setApprovalOpen] = useState(false);

  const total = useMemo(
    () => stock.reduce((sum, st) => sum + st.quantity, 0),
    [stock]
  );

  const reload = useCallback(() => {
    setItem(getItemById(id));
    setStock(getStockByItem(id));
  }, [id]);

  // Equipment items are managed in the Equipment tab — redirect immediately
  useEffect(() => {
    if (item?.kind === 'equipment') {
      router.replace({ pathname: '/(app)/(equipment)/[id]', params: { id } });
    }
  }, [item?.kind, id, router]);

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
    // The stored id is already the final location/shelf id, so it seeds the
    // location field; the shelf sub-field starts empty and only reappears if the
    // user re-picks a has_shelves parent.
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
    // editMinAlert is already a valid clamped integer (QuantityStepper enforces
    // min 0) — no separate parse/Alert step needed, same effective range.
    const reorder = parseOptionalCount(form.reorder_to, 'Reorder up to');
    if (!reorder.ok) { trackReject('item.reorder_to', reorder.rule); Alert.alert('Invalid reorder amount', reorder.error); return; }
    const pack = parsePackSize(form.pack_size ?? '');
    if (!pack.ok) { trackReject('item.pack_size', pack.rule); Alert.alert('Invalid pack size', pack.error); return; }

    // Resolve the (location, shelf) pair into the single home-location id BEFORE
    // building the update so a failed shelf create can't silently drop it. Abort
    // with a message instead.
    const locRes = resolveLocationShelfSelection(editHomeLocation, editHomeShelf);
    if (!locRes.ok) {
      Alert.alert('Couldn’t add that location', `Could not create shelf “${locRes.shelfLabel}”. Please try again.`);
      return;
    }
    const homeLocationId = locRes.id;

    const fields = {
      name: form.name.trim(),
      model: form.model.trim() || null,
      description: form.description.trim() || null,
      barcode: form.barcode.trim() || null,
      sku: form.sku.trim() || null,
      supplier: form.supplier.trim() || null,
      min_qty_alert: editMinAlert,
      reorder_to: reorder.value,
      category: editCategory.trim() || null,
      returnable: (editReturnable ? 1 : 0) as number,
      // Keep unit_category a real product_class id so formatQuantity decimals
      // stay correct; never write an empty unit (fall back to the existing one).
      unit_category: editUnitCat || PRODUCT_CLASS_IDS.piece,
      unit: editUnit.trim() || item.unit,
      home_location_id: homeLocationId,
      pack_size: pack.value,
    };
    const synced = updateItemFields(item.id, fields);
    // Outbox: send returnable as real boolean (Postgres column is BOOLEAN)
    appendOutbox('UPDATE', 'inventory_items', { ...synced, returnable: editReturnable });
    setEditing(false);
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
      <KeyboardAvoidingView style={s.container} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled">
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
                  custom one. SelectField's own free-text fallback only renders
                  when mergedEditUnitOptions is empty, which is unreachable here
                  (an existing item's own unit is always merged in) — so without
                  this second field there'd be no way to enter a custom unit.
                  Both bind to the same editUnit state: picking from the sheet
                  sets it, typing below overrides it. */}
              {mergedEditUnitOptions.length > 0 && (
                <SelectField
                  label="Unit"
                  value={editUnit || null}
                  options={mergedEditUnitOptions.map(u => ({ id: u, label: u }))}
                  onSelect={setEditUnit}
                />
              )}
              <TextField label="Custom unit" value={editUnit} onChangeText={setEditUnit} placeholder="Unit (e.g. each)" autoCapitalize="none" />
              <View style={s.switchRow}>
                <Text style={s.switchLabel}>Returnable? (expected back via Check In)</Text>
                <Switch value={editReturnable} onValueChange={setEditReturnable} />
              </View>
              <QuantityStepper label="Low-stock alert (0 = off)" value={editMinAlert} onChange={setEditMinAlert} min={0} max={MAX_QUANTITY} />
              {/* Reorder up to / Pack size stay plain text fields (not
                  QuantityStepper): blank vs 0 is a meaningful distinction for
                  both (0 is a real, if unusual, reorder-to-zero value; a pack
                  size of exactly 0/1 is a validation error, not an "off" state) —
                  unlike the low-stock alert's established "0 = off" convention. */}
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
                <View style={s.attrRow}>
                  <Text style={s.attrKey}>Returnable</Text>
                  <View style={[s.badge, item.returnable ? s.badgeReturn : s.badgeConsume]}>
                    <Text style={[s.badgeText, item.returnable ? s.badgeReturnText : s.badgeConsumeText]}>
                      {item.returnable ? 'Returnable' : 'Consumed'}
                    </Text>
                  </View>
                </View>
              </View>

              <TouchableOpacity style={[s.card, s.attrRow]} onPress={() => setPrintItemSheet(true)}>
                <Text style={s.attrKey}>🏷 Print QR Label</Text>
                <Text style={s.attrVal}>›</Text>
              </TouchableOpacity>

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

              <Text style={s.sectionLabel}>Photos</Text>
              <MediaGallery entityType="item" entityId={id} canUpload={canUpload} />

              <TouchableOpacity style={[s.card, s.attrRow]} onPress={() => setApprovalOpen(true)}>
                <Text style={s.attrKey}>✅ Request Approval</Text>
                <Text style={s.attrVal}>›</Text>
              </TouchableOpacity>

              {canEdit && (
                <PrimaryButton label="Edit Item" onPress={startEdit} />
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* ── Print QR Label (item) ──────────────────────────────────────── */}
      <LabelPrintSheet
        visible={printItemSheet}
        onClose={() => setPrintItemSheet(false)}
        title={item.name}
        code={item.barcode ?? item.id}
        qrUrl={`${API}/labels/item/${item.id}/qr.png`}
      />

      {/* ── Request Approval (item) ────────────────────────────────────── */}
      <RequestApprovalSheet
        visible={approvalOpen}
        onClose={() => setApprovalOpen(false)}
        entityType="item"
        entityId={item.id}
        entityLabel={item.name}
      />
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

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 12, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { fontSize: 14, color: colors.textMuted },
  card: { backgroundColor: colors.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: colors.borderDetail },
  name: { fontSize: 22, fontWeight: '700', color: colors.brand },
  model: { fontSize: 14, color: colors.primary, marginTop: 2, fontWeight: '600' },
  desc: { fontSize: 14, color: '#475569', marginTop: 8, lineHeight: 20 },
  belongsAt: { fontSize: 13, color: colors.primary, marginTop: 8, fontWeight: '600' },
  totalRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 14 },
  totalNum: { fontSize: 26, fontWeight: '800', color: '#0F172A' },
  totalLbl: { fontSize: 13, color: colors.textSecondary },
  lowStock: { marginTop: 8, color: colors.danger, fontSize: 13, fontWeight: '600' },
  sectionLabel: { fontSize: 12, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 4 },
  attrRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 11 },
  attrKey: { fontSize: 14, color: colors.textSecondary },
  attrVal: { fontSize: 14, color: colors.textPrimary, fontWeight: '600', maxWidth: '60%', textAlign: 'right' },
  divider: { borderBottomWidth: 1, borderBottomColor: '#F1F5F9' },
  stockRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12 },
  stockLoc: { fontSize: 15, color: colors.textPrimary, fontWeight: '600' },
  stockParent: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  stockQty: { fontSize: 15, fontWeight: '700', color: colors.success },
  stockZero: { color: colors.textDisabled },
  fieldWrap: { gap: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  // Item-type chip + its colored type dot, grouped so they read as one unit.
  chipWithDot: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  typeDot: { width: 9, height: 9, borderRadius: 5 },
  row: { flexDirection: 'row', gap: 12, marginTop: 16 },
  btn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', marginTop: 8, flex: 1 },
  btnGhost: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.textDisabled },
  btnGhostText: { color: '#475569', fontWeight: '600', fontSize: 16 },
  badge: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  badgeReturn: { backgroundColor: '#D1FAE5' },
  badgeReturnText: { color: '#065F46', fontWeight: '700', fontSize: 13 },
  badgeConsume: { backgroundColor: colors.dangerBg },
  badgeConsumeText: { color: '#991B1B', fontWeight: '700', fontSize: 13 },
  badgeText: { fontSize: 13, fontWeight: '700' },
  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: colors.surface, borderRadius: 10, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 10,
  },
  switchLabel: { fontSize: 14, color: colors.textPrimary, flex: 1, marginRight: 12 },
});
