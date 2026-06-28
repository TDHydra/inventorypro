import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet,
  ScrollView, Alert, KeyboardAvoidingView, Platform, Switch,
} from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  getItemById, getStockByItem, updateItemFields, getDistinctValues,
  InventoryItem, StockByLocation,
} from '../../../src/db/queries/items';
import { appendOutbox } from '../../../src/sync/outbox';
import { usePermission } from '../../../src/hooks/usePermission';
import { UnitCategory, formatQuantity, PRODUCT_CLASS_IDS, getUnitsForClass } from '../../../src/constants/units';
import { getProductClassById, getProductClasses, getItemTypes, parseItemTypeMeta, TaxonomyType } from '../../../src/db/queries/taxonomy';
import { BarcodeInput } from '../../../src/components/BarcodeInput';
import { SuggestInput } from '../../../src/components/SuggestInput';
import { MediaGallery } from '../../../src/components/MediaGallery';
import { colors } from '../../../src/theme';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { LabelPrintSheet } from '../../../src/components/LabelPrintSheet';

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const canEdit = usePermission('edit_inventory');
  const canUpload = usePermission('upload_media');

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

  // Admin-managed Item Types (PPE, Filters, …) and product classes (unit class
  // override). Each item type carries its curated units + unit class in meta.
  const itemTypes = useMemo(() => getItemTypes(), []);
  const productClasses = useMemo(() => getProductClasses(), []);

  const supplierOptions = useMemo(() => getDistinctValues('supplier'), []);
  const modelOptions = useMemo(() => getDistinctValues('model'), []);
  const categoryOptions = useMemo(() => getDistinctValues('category'), []);

  // Label print sheet state
  const [printItemSheet, setPrintItemSheet] = useState(false);

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
      min_qty_alert: String(item.min_qty_alert ?? 0),
      reorder_to: item.reorder_to != null ? String(item.reorder_to) : '',
    });
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
      // Keep unit_category a real product_class id so formatQuantity decimals
      // stay correct; never write an empty unit (fall back to the existing one).
      unit_category: editUnitCat || PRODUCT_CLASS_IDS.piece,
      unit: editUnit.trim() || item.unit,
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
              {itemTypes.length > 0 && (
                <View style={s.fieldWrap}>
                  <FieldLabel>Item type</FieldLabel>
                  <View style={s.chipRow}>
                    {itemTypes.map(t => (
                      <FilterChip
                        key={t.id}
                        label={t.icon ? `${t.icon} ${t.label}` : t.label}
                        active={editItemType === t.label}
                        onPress={() => selectItemType(t)}
                      />
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
              <View style={s.fieldWrap}>
                <FieldLabel>Unit</FieldLabel>
                {editUnitOptions.length > 0 && (
                  <View style={s.chipRow}>
                    {editUnitOptions.map(u => (
                      <FilterChip
                        key={u}
                        label={u}
                        active={editUnit === u}
                        onPress={() => setEditUnit(u)}
                      />
                    ))}
                  </View>
                )}
                <AppInput
                  value={editUnit}
                  onChangeText={setEditUnit}
                  placeholder="Unit (e.g. each)"
                  autoCapitalize="none"
                />
              </View>
              <View style={s.switchRow}>
                <Text style={s.switchLabel}>Returnable? (expected back via Check In)</Text>
                <Switch value={editReturnable} onValueChange={setEditReturnable} />
              </View>
              <Field label="Low-stock alert" value={form.min_qty_alert} onChange={setField('min_qty_alert')} keyboardType="decimal-pad" />
              <Field label="Reorder up to" value={form.reorder_to} onChange={setField('reorder_to')} keyboardType="decimal-pad" />

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
  multiline: { height: 80, paddingTop: 12, textAlignVertical: 'top' },
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
