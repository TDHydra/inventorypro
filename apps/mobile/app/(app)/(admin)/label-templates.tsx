import { useState, useRef, useMemo, useCallback } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet,
  PanResponder, Animated, useWindowDimensions,
} from 'react-native';
import { Stack } from 'expo-router';
import { Alert } from '../../../src/lib/themedAlert';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { generateUUID } from '../../../src/utils/uuid';
import {
  getLabelTemplates, upsertLabelTemplate, deleteLabelTemplate,
} from '../../../src/db/queries/labelTemplates';
import type { LabelTemplateModel, LabelField, LabelFieldType } from '../../../src/labels/positioned';
import { colors, spacing, fontSizes, radii } from '../../../src/theme';
import { FilterChip } from '../../../src/components/ui/FilterChip';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const SIZE_PRESETS = [
  { label: '2.25×1.25', widthIn: 2.25, heightIn: 1.25, dpi: 203 },
  { label: '4×2', widthIn: 4, heightIn: 2, dpi: 203 },
  { label: '4×3', widthIn: 4, heightIn: 3, dpi: 203 },
  { label: 'DYMO 3.5×1.1', widthIn: 3.5, heightIn: 1.125, dpi: 300 },
  { label: 'Zebra 2×1', widthIn: 2, heightIn: 1, dpi: 203 },
];

const FIELD_TYPES: { type: LabelFieldType; label: string }[] = [
  { type: 'qr', label: 'QR' },
  { type: 'code128', label: 'Barcode' },
  { type: 'item_name', label: 'Item name' },
  { type: 'asset_tag', label: 'Asset tag' },
  { type: 'static_text', label: 'Text' },
];

function fieldPreview(f: LabelField): string {
  switch (f.type) {
    case 'qr': return '▣ QR';
    case 'code128': return '||||| Barcode';
    case 'item_name': return 'Item name';
    case 'asset_tag': return 'Asset tag';
    case 'static_text': return f.text || 'Text';
  }
}

// ── One draggable + resizable field box on the canvas ──────────────────────
function FieldBox({ field, canvasW, canvasH, selected, onSelect, onChange }: {
  field: LabelField; canvasW: number; canvasH: number; selected: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<LabelField>) => void;
}) {
  const pan = useRef(new Animated.ValueXY({ x: 0, y: 0 })).current;
  // Ref mirror so the once-created PanResponders always read fresh props.
  const cfg = useRef({ field, canvasW, canvasH, onChange, onSelect });
  cfg.current = { field, canvasW, canvasH, onChange, onSelect };
  const startSize = useRef({ w: 0, h: 0 });

  const drag = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2,
    onPanResponderGrant: () => cfg.current.onSelect(cfg.current.field.id),
    onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
    onPanResponderRelease: (_e, g) => {
      const c = cfg.current;
      pan.setValue({ x: 0, y: 0 });
      c.onChange(c.field.id, {
        x: clamp(c.field.x + g.dx / c.canvasW, 0, 1 - c.field.w),
        y: clamp(c.field.y + g.dy / c.canvasH, 0, 1 - c.field.h),
      });
    },
    onPanResponderTerminate: () => pan.setValue({ x: 0, y: 0 }),
  }), [pan]);

  // Resize commits live (state) — anchor to the size captured on grant so the
  // cumulative gesture delta isn't double-counted as field.w/h grows.
  const resize = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      const c = cfg.current;
      c.onSelect(c.field.id);
      startSize.current = { w: c.field.w, h: c.field.h };
    },
    onPanResponderMove: (_e, g) => {
      const c = cfg.current;
      c.onChange(c.field.id, {
        w: clamp(startSize.current.w + g.dx / c.canvasW, 0.06, 1 - c.field.x),
        h: clamp(startSize.current.h + g.dy / c.canvasH, 0.06, 1 - c.field.y),
      });
    },
  }), []);

  return (
    <Animated.View
      {...drag.panHandlers}
      style={[
        s.field, selected && s.fieldSelected,
        {
          left: field.x * canvasW, top: field.y * canvasH,
          width: field.w * canvasW, height: field.h * canvasH,
          transform: pan.getTranslateTransform(),
        },
      ]}
    >
      <Text style={s.fieldPreview} numberOfLines={2}>{fieldPreview(field)}</Text>
      {selected && <View {...resize.panHandlers} style={s.resizeHandle} />}
    </Animated.View>
  );
}

// ── The editor (canvas + property panel) ───────────────────────────────────
function Editor({ initial, userId, onDone }: {
  initial: LabelTemplateModel; userId: string | null; onDone: () => void;
}) {
  const { width } = useWindowDimensions();
  const [model, setModel] = useState<LabelTemplateModel>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial.fields[0]?.id ?? null);

  const canvasW = width - spacing.base * 2 - 2; // page padding + border
  const canvasH = canvasW * (model.heightIn / model.widthIn);
  const selected = model.fields.find(f => f.id === selectedId) ?? null;

  const patchField = useCallback((id: string, patch: Partial<LabelField>) => {
    setModel(m => ({ ...m, fields: m.fields.map(f => (f.id === id ? { ...f, ...patch } : f)) }));
  }, []);

  function addField() {
    const f: LabelField = { id: generateUUID(), type: 'static_text', x: 0.3, y: 0.4, w: 0.4, h: 0.18, fontPt: 10, align: 'center', text: 'Text' };
    setModel(m => ({ ...m, fields: [...m.fields, f] }));
    setSelectedId(f.id);
  }
  function removeSelected() {
    if (!selected) return;
    setModel(m => ({ ...m, fields: m.fields.filter(f => f.id !== selected.id) }));
    setSelectedId(null);
  }
  function setSize(p: typeof SIZE_PRESETS[number]) {
    setModel(m => ({ ...m, widthIn: p.widthIn, heightIn: p.heightIn, dpi: p.dpi }));
  }
  function save() {
    if (!model.name.trim()) { Alert.alert('Name required', 'Give the template a name.'); return; }
    upsertLabelTemplate({ ...model, name: model.name.trim() }, userId);
    onDone();
  }

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.base, paddingBottom: spacing.xxl }} keyboardShouldPersistTaps="handled">
      <FieldLabel text="Template name" />
      <TextInput style={s.input} value={model.name} onChangeText={t => setModel(m => ({ ...m, name: t }))} placeholder="e.g. Warehouse 4×2" placeholderTextColor={colors.textMuted} />

      <FieldLabel text="Media size" />
      <View style={s.chipRow}>
        {SIZE_PRESETS.map(p => (
          <FilterChip key={p.label} label={p.label}
            active={model.widthIn === p.widthIn && model.heightIn === p.heightIn}
            onPress={() => setSize(p)} />
        ))}
      </View>

      <FieldLabel text={`Canvas (${model.widthIn}×${model.heightIn}in) — drag to move, corner to resize`} />
      <View style={[s.canvas, { width: canvasW, height: canvasH }]}>
        {model.fields.map(f => (
          <FieldBox key={f.id} field={f} canvasW={canvasW} canvasH={canvasH}
            selected={f.id === selectedId} onSelect={setSelectedId} onChange={patchField} />
        ))}
        {model.fields.length === 0 && <Text style={s.canvasHint}>Add a field below</Text>}
      </View>

      <TouchableOpacity style={s.addBtn} onPress={addField}><Text style={s.addBtnText}>+ Add field</Text></TouchableOpacity>

      {selected && (
        <View style={s.panel}>
          <Text style={s.panelTitle}>Field</Text>
          <FieldLabel text="Type" />
          <View style={s.chipRow}>
            {FIELD_TYPES.map(ft => (
              <FilterChip key={ft.type} label={ft.label} active={selected.type === ft.type}
                onPress={() => patchField(selected.id, { type: ft.type })} />
            ))}
          </View>
          {selected.type === 'static_text' && (
            <>
              <FieldLabel text="Text" />
              <TextInput style={s.input} value={selected.text ?? ''} onChangeText={t => patchField(selected.id, { text: t })} placeholder="Static text" placeholderTextColor={colors.textMuted} />
            </>
          )}
          {(selected.type === 'static_text' || selected.type === 'item_name' || selected.type === 'asset_tag') && (
            <>
              <FieldLabel text="Font size" />
              <View style={s.chipRow}>
                {[7, 8, 10, 12, 16, 20].map(pt => (
                  <FilterChip key={pt} label={`${pt}pt`} active={(selected.fontPt ?? 10) === pt} onPress={() => patchField(selected.id, { fontPt: pt })} />
                ))}
              </View>
              <FieldLabel text="Align" />
              <View style={s.chipRow}>
                {(['left', 'center', 'right'] as const).map(a => (
                  <FilterChip key={a} label={a} active={(selected.align ?? 'center') === a} onPress={() => patchField(selected.id, { align: a })} />
                ))}
              </View>
            </>
          )}
          <TouchableOpacity style={s.removeBtn} onPress={removeSelected}><Text style={s.removeBtnText}>Remove field</Text></TouchableOpacity>
        </View>
      )}

      <View style={s.actions}>
        <TouchableOpacity style={s.cancelBtn} onPress={onDone}><Text style={s.cancelText}>Cancel</Text></TouchableOpacity>
        <TouchableOpacity style={s.saveBtn} onPress={save}><Text style={s.saveText}>Save template</Text></TouchableOpacity>
      </View>
    </ScrollView>
  );
}

function FieldLabel({ text }: { text: string }) {
  return <Text style={s.fieldLabel}>{text}</Text>;
}

// ── Screen: list ↔ editor ───────────────────────────────────────────────────
export default function LabelTemplatesScreen() {
  const isAdmin = usePermission('system_settings');
  const { user } = useSession();
  const [editing, setEditing] = useState<LabelTemplateModel | null>(null);
  const [version, setVersion] = useState(0);
  const templates = useMemo(() => (isAdmin ? getLabelTemplates() : []), [isAdmin, version]);

  const reload = () => setVersion(v => v + 1);

  if (!isAdmin) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: 'Label Designer' }} />
        <Text style={s.muted}>You don’t have access to the label designer.</Text>
      </View>
    );
  }

  if (editing) {
    return (
      <View style={s.container}>
        <Stack.Screen options={{ title: editing.name || 'New template' }} />
        <Editor initial={editing} userId={user?.id ?? null} onDone={() => { setEditing(null); reload(); }} />
      </View>
    );
  }

  function newTemplate() {
    setEditing({ id: generateUUID(), name: '', widthIn: 4, heightIn: 2, dpi: 203, fields: [] });
  }
  function confirmDelete(t: LabelTemplateModel) {
    Alert.alert('Delete template', `Delete “${t.name}”?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { deleteLabelTemplate(t.id); reload(); } },
    ]);
  }

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: 'Label Designer' }} />
      <ScrollView contentContainerStyle={{ padding: spacing.base }}>
        <TouchableOpacity style={s.newBtn} onPress={newTemplate}><Text style={s.newBtnText}>+ New template</Text></TouchableOpacity>
        {templates.length === 0 ? (
          <Text style={s.muted}>No custom templates yet. Create one to design a label layout.</Text>
        ) : templates.map(t => (
          <View key={t.id} style={s.card}>
            <TouchableOpacity style={{ flex: 1 }} onPress={() => setEditing(t)}>
              <Text style={s.cardName}>{t.name}</Text>
              <Text style={s.cardSub}>{t.widthIn}×{t.heightIn}in · {t.fields.length} field{t.fields.length === 1 ? '' : 's'}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setEditing(t)}><Text style={s.edit}>Edit</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => confirmDelete(t)}><Text style={s.del}>Delete</Text></TouchableOpacity>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  muted: { color: colors.textMuted, fontSize: fontSizes.body, marginTop: spacing.base },
  fieldLabel: { fontSize: fontSizes.caption, color: colors.textSecondary, fontWeight: '600', marginTop: spacing.base, marginBottom: spacing.xs },
  input: { backgroundColor: colors.surface, borderRadius: radii.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingHorizontal: spacing.sm, paddingVertical: 10, color: colors.textPrimary, fontSize: fontSizes.body },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  canvas: { backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border, borderRadius: 2, marginTop: spacing.xs, position: 'relative', overflow: 'hidden', alignSelf: 'center' },
  canvasHint: { position: 'absolute', alignSelf: 'center', top: '45%', color: '#94A3B8', fontSize: 13 },
  field: { position: 'absolute', borderWidth: 1, borderColor: '#94A3B8', borderStyle: 'dashed', backgroundColor: 'rgba(37,99,235,0.06)', alignItems: 'center', justifyContent: 'center', padding: 2 },
  fieldSelected: { borderColor: colors.primary, borderStyle: 'solid', backgroundColor: 'rgba(37,99,235,0.14)' },
  fieldPreview: { fontSize: 10, color: '#334155', textAlign: 'center' },
  resizeHandle: { position: 'absolute', right: -7, bottom: -7, width: 16, height: 16, borderRadius: 8, backgroundColor: colors.primary, borderWidth: 2, borderColor: '#fff' },
  addBtn: { alignSelf: 'flex-start', marginTop: spacing.sm, paddingVertical: spacing.xs, paddingHorizontal: spacing.base, borderRadius: radii.sm, backgroundColor: colors.primaryBg },
  addBtnText: { color: colors.primaryText, fontWeight: '700' },
  panel: { marginTop: spacing.base, backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.base, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  panelTitle: { fontSize: fontSizes.body, fontWeight: '700', color: colors.textPrimary },
  removeBtn: { marginTop: spacing.base, alignSelf: 'flex-start' },
  removeBtnText: { color: colors.danger, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg },
  cancelBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  cancelText: { color: colors.textSecondary, fontWeight: '600' },
  saveBtn: { flex: 2, alignItems: 'center', paddingVertical: 12, borderRadius: radii.md, backgroundColor: colors.primary },
  saveText: { color: '#fff', fontWeight: '800' },
  newBtn: { alignSelf: 'flex-start', paddingVertical: spacing.sm, paddingHorizontal: spacing.base, borderRadius: radii.md, backgroundColor: colors.primary, marginBottom: spacing.base },
  newBtnText: { color: '#fff', fontWeight: '800' },
  card: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.base, marginBottom: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  cardName: { fontSize: fontSizes.body, fontWeight: '700', color: colors.textPrimary },
  cardSub: { fontSize: fontSizes.caption, color: colors.textSecondary, marginTop: 2 },
  edit: { color: colors.primaryText, fontWeight: '700', paddingHorizontal: spacing.xs },
  del: { color: colors.danger, fontWeight: '600', paddingHorizontal: spacing.xs },
});
