import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet,
  ScrollView, Alert, KeyboardAvoidingView, Platform,
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

export default function ItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const canEdit = usePermission('edit_inventory');
  const canUpload = usePermission('upload_media');

  const [item, setItem] = useState<InventoryItem | null>(() => getItemById(id));
  const [stock, setStock] = useState<StockByLocation[]>(() => getStockByItem(id));
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<string, string>>({});

  const supplierOptions = useMemo(() => getDistinctValues('supplier'), []);
  const modelOptions = useMemo(() => getDistinctValues('model'), []);

  const total = useMemo(() => stock.reduce((sum, st) => sum + st.quantity, 0), [stock]);

  const reload = useCallback(() => {
    setItem(getItemById(id));
    setStock(getStockByItem(id));
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
    };
    const synced = updateItemFields(item.id, fields);
    appendOutbox('UPDATE', 'inventory_items', synced);
    setEditing(false);
    reload();
  }

  const setField = (k: string) => (v: string) => setForm(f => ({ ...f, [k]: v }));
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
                <Row k="Category" v={UNIT_CATEGORY_LABELS[cat]} />
                <Row k="Unit" v={item.unit} />
                <Row k="Barcode" v={item.barcode ?? '—'} />
                <Row k="SKU / Part #" v={item.sku ?? '—'} />
                <Row k="Supplier" v={item.supplier ?? '—'} />
                <Row k="Low-stock alert" v={item.min_qty_alert > 0 ? String(item.min_qty_alert) : 'Off'} />
                <Row k="Reorder up to" v={item.reorder_to != null ? String(item.reorder_to) : '—'} last />
              </View>

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
                <TouchableOpacity style={[s.btn, s.btnPrimary]} onPress={startEdit}>
                  <Text style={s.btnPrimaryText}>Edit Item</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
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
});
