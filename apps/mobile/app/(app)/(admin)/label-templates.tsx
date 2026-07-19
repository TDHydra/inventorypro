import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, TextInput, ScrollView, TouchableOpacity, StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { Stack } from 'expo-router';
import { Alert } from '../../../src/lib/themedAlert';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useTableVersion } from '../../../src/hooks/useDataVersion';
import { generateUUID } from '../../../src/utils/uuid';
import {
  getLabelTemplates, upsertLabelTemplate, deleteLabelTemplate,
} from '../../../src/db/queries/labelTemplates';
import type { LabelTemplateModel, LabelField, LabelFieldType } from '../../../src/labels/positioned';
import type { Theme } from '../../../src/themes/types';
import { useTheme } from '../../../src/hooks/useTheme';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { FormScreen } from '../../../src/components/ui/FormScreen';
import { DraggableResizableBox } from '../../../src/components/DraggableResizableBox';

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
// Thin wrapper over the reusable DraggableResizableBox: gesture arbitration
// (corner resizes, body drags) lives there; here we just render the preview.
function FieldBox({ field, canvasW, canvasH, selected, onSelect, onChange, onDragStart, onDragEnd }: {
  field: LabelField; canvasW: number; canvasH: number; selected: boolean;
  onSelect: (id: string) => void;
  onChange: (id: string, patch: Partial<LabelField>) => void;
  /** Called when a drag/resize gesture starts — used to freeze parent scroll. */
  onDragStart: () => void;
  /** Called when a drag/resize gesture ends or is cancelled. */
  onDragEnd: () => void;
}) {
  const s = useThemedStyles(makeStyles);
  return (
    <DraggableResizableBox
      id={field.id}
      x={field.x} y={field.y} w={field.w} h={field.h}
      canvasW={canvasW} canvasH={canvasH}
      selected={selected}
      onSelect={onSelect}
      onChange={onChange}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={s.field}
      selectedStyle={s.fieldSelected}
      handleStyle={s.resizeHandle}
    >
      <Text style={s.fieldPreview} numberOfLines={2}>{fieldPreview(field)}</Text>
    </DraggableResizableBox>
  );
}

// ── The editor (canvas + property panel) ───────────────────────────────────
function Editor({ initial, userId, onDone }: {
  initial: LabelTemplateModel; userId: string | null; onDone: () => void;
}) {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const { width } = useWindowDimensions();
  const [model, setModel] = useState<LabelTemplateModel>(initial);
  const [selectedId, setSelectedId] = useState<string | null>(initial.fields[0]?.id ?? null);
  // Freeze scroll while a field is being dragged or resized so the parent
  // ScrollView cannot steal the PanResponder mid-gesture.
  const [dragging, setDragging] = useState(false);

  const canvasW = width - t.spacing.base * 2 - 2; // page padding + border
  const canvasH = canvasW * (model.heightIn / model.widthIn);
  const selected = model.fields.find(f => f.id === selectedId) ?? null;

  const patchField = useCallback((id: string, patch: Partial<LabelField>) => {
    setModel(m => ({ ...m, fields: m.fields.map(f => (f.id === id ? { ...f, ...patch } : f)) }));
  }, []);

  const handleDragStart = useCallback(() => setDragging(true), []);
  const handleDragEnd = useCallback(() => setDragging(false), []);

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
    <FormScreen
      scrollEnabled={!dragging}
      contentContainerStyle={{ padding: t.spacing.base, paddingBottom: t.spacing.xxl }}
    >
      <FieldLabel text="Template name" />
      <TextInput style={s.input} value={model.name} onChangeText={t => setModel(m => ({ ...m, name: t }))} placeholder="e.g. Warehouse 4×2" placeholderTextColor={t.colors.textMuted} />

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
            selected={f.id === selectedId} onSelect={setSelectedId} onChange={patchField}
            onDragStart={handleDragStart} onDragEnd={handleDragEnd} />
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
              <TextInput style={s.input} value={selected.text ?? ''} onChangeText={t => patchField(selected.id, { text: t })} placeholder="Static text" placeholderTextColor={t.colors.textMuted} />
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
    </FormScreen>
  );
}

function FieldLabel({ text }: { text: string }) {
  const s = useThemedStyles(makeStyles);
  return <Text style={s.fieldLabel}>{text}</Text>;
}

// ── Screen: list ↔ editor ───────────────────────────────────────────────────
export default function LabelTemplatesScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const isAdmin = usePermission('system_settings');
  const { user } = useSession();
  const [editing, setEditing] = useState<LabelTemplateModel | null>(null);
  // Re-read on any local or synced change to label_templates (bus-driven; own
  // writes tick it too, so no manual reload after save/delete).
  const version = useTableVersion(['label_templates']);
  const templates = useMemo(() => (isAdmin ? getLabelTemplates() : []), [isAdmin, version]);

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
        <Editor initial={editing} userId={user?.id ?? null} onDone={() => setEditing(null)} />
      </View>
    );
  }

  function newTemplate() {
    setEditing({ id: generateUUID(), name: '', widthIn: 4, heightIn: 2, dpi: 203, fields: [] });
  }
  function confirmDelete(t: LabelTemplateModel) {
    Alert.alert('Delete template', `Delete “${t.name}”?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteLabelTemplate(t.id) },
    ]);
  }

  return (
    <View style={s.container}>
      <Stack.Screen options={{ title: 'Label Designer' }} />
      <ScrollView contentContainerStyle={{ padding: t.spacing.base }}>
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

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.spacing.xl },
  muted: { color: t.colors.textMuted, fontSize: t.typography.fontSizes.body, marginTop: t.spacing.base },
  fieldLabel: { fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary, fontWeight: '600', marginTop: t.spacing.base, marginBottom: t.spacing.xs },
  input: { backgroundColor: t.colors.surface, borderRadius: t.radii.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border, paddingHorizontal: t.spacing.sm, paddingVertical: 10, color: t.colors.textPrimary, fontSize: t.typography.fontSizes.body },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.xs },
  canvas: { backgroundColor: '#fff', borderWidth: 1, borderColor: t.colors.border, borderRadius: 2, marginTop: t.spacing.xs, position: 'relative', overflow: 'hidden', alignSelf: 'center' },
  canvasHint: { position: 'absolute', alignSelf: 'center', top: '45%', color: t.colors.textMuted, fontSize: 13 },
  field: { position: 'absolute', borderWidth: 1, borderColor: t.colors.textMuted, borderStyle: 'dashed', backgroundColor: 'rgba(37,99,235,0.06)', alignItems: 'center', justifyContent: 'center', padding: 2 },
  fieldSelected: { borderColor: t.colors.primary, borderStyle: 'solid', backgroundColor: 'rgba(37,99,235,0.14)' },
  fieldPreview: { fontSize: 10, color: t.colors.textStrong, textAlign: 'center' },
  resizeHandle: { position: 'absolute', right: -7, bottom: -7, width: 16, height: 16, borderRadius: 8, backgroundColor: t.colors.primary, borderWidth: 2, borderColor: '#fff' },
  addBtn: { alignSelf: 'flex-start', marginTop: t.spacing.sm, paddingVertical: t.spacing.xs, paddingHorizontal: t.spacing.base, borderRadius: t.radii.sm, backgroundColor: t.colors.primaryBg },
  addBtnText: { color: t.colors.primaryText, fontWeight: '700' },
  panel: { marginTop: t.spacing.base, backgroundColor: t.colors.surface, borderRadius: t.radii.md, padding: t.spacing.base, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border },
  panelTitle: { fontSize: t.typography.fontSizes.body, fontWeight: '700', color: t.colors.textPrimary },
  removeBtn: { marginTop: t.spacing.base, alignSelf: 'flex-start' },
  removeBtnText: { color: t.colors.danger, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: t.spacing.sm, marginTop: t.spacing.lg },
  cancelBtn: { flex: 1, alignItems: 'center', paddingVertical: 12, borderRadius: t.radii.md, backgroundColor: t.colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border },
  cancelText: { color: t.colors.textSecondary, fontWeight: '600' },
  saveBtn: { flex: 2, alignItems: 'center', paddingVertical: 12, borderRadius: t.radii.md, backgroundColor: t.colors.primary },
  saveText: { color: t.colors.onPrimary, fontWeight: '800' },
  newBtn: { alignSelf: 'flex-start', paddingVertical: t.spacing.sm, paddingHorizontal: t.spacing.base, borderRadius: t.radii.md, backgroundColor: t.colors.primary, marginBottom: t.spacing.base },
  newBtnText: { color: t.colors.onPrimary, fontWeight: '800' },
  card: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, backgroundColor: t.colors.surface, borderRadius: t.radii.md, padding: t.spacing.base, marginBottom: t.spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border },
  cardName: { fontSize: t.typography.fontSizes.body, fontWeight: '700', color: t.colors.textPrimary },
  cardSub: { fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary, marginTop: 2 },
  edit: { color: t.colors.primaryText, fontWeight: '700', paddingHorizontal: t.spacing.xs },
  del: { color: t.colors.danger, fontWeight: '600', paddingHorizontal: t.spacing.xs },
});
