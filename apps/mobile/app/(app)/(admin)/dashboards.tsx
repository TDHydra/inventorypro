import { useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { ROLE_TIER, ROLE_DISPLAY_NAMES, type UserRole } from '../../../src/constants/roles';
import {
  WIDGET_REGISTRY,
  type WidgetType,
  type Layout,
  type LayoutBlock,
} from '../../../src/dashboard/widgets';
import { parsePresetLayout } from '../../../src/dashboard/resolve';
import {
  getDashboardPresets,
  getDashboardPresetById,
  createDashboardPreset,
  renameDashboardPreset,
  setDashboardPresetLayout,
  setDashboardPresetActive,
  setRoleDashboardPreset,
  getRoleDashboardPresetIds,
  type DashboardPreset,
} from '../../../src/db/queries/dashboards';
import { generateUUID } from '../../../src/utils/uuid';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { DragList } from '../../../src/components/ui/DragList';

// A block in the working editor, tagged with a synthetic stable key so the
// reorder animation reconciles correctly (persisted Layout carries no ids).
type KeyedBlock = { key: string; block: LayoutBlock };

const ROW_HEIGHT = 60;

// Roles listed in tier order (highest first) for the role-defaults section.
const ROLES_ORDERED = (Object.keys(ROLE_TIER) as UserRole[]).sort(
  (a, b) => ROLE_TIER[b] - ROLE_TIER[a] || ROLE_DISPLAY_NAMES[a].localeCompare(ROLE_DISPLAY_NAMES[b]),
);

// Registry entries split into the two picker groups.
const TILE_WIDGETS = (Object.keys(WIDGET_REGISTRY) as WidgetType[]).filter(
  (w) => WIDGET_REGISTRY[w].kind === 'tile',
);
const BLOCK_WIDGETS = (Object.keys(WIDGET_REGISTRY) as WidgetType[]).filter(
  (w) => WIDGET_REGISTRY[w].kind === 'block',
);

// Human-readable name for a non-tile block (registry label is blank for these).
const BLOCK_NAMES: Record<string, string> = {
  section: 'Section Header',
  search: 'Pinned Search',
  'quick-add': 'Quick Add CTA',
  'low-stock': 'Low-Stock List',
};

function widgetDisplay(block: LayoutBlock): { icon: string; label: string } {
  const def = WIDGET_REGISTRY[block.widget];
  if (block.widget === 'section') {
    return { icon: '▤', label: block.config?.sectionTitle?.trim() || 'Section' };
  }
  if (def.kind === 'block') {
    return { icon: '▦', label: BLOCK_NAMES[block.widget] ?? block.widget };
  }
  return {
    icon: block.config?.icon?.trim() || def.icon || '•',
    label: block.config?.label?.trim() || def.label,
  };
}

export default function DashboardsScreen() {
  const { user } = useSession();
  const isTier4 = user != null && ROLE_TIER[user.role] === 4;

  const [presets, setPresets] = useState<DashboardPreset[]>(() => getDashboardPresets());
  const [roleMap, setRoleMap] = useState<Record<string, string | null>>(() => getRoleDashboardPresetIds());

  // Editor state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<KeyedBlock[]>([]);

  // Name modal (create / rename)
  const [nameModal, setNameModal] = useState<{ mode: 'create' | 'rename'; id?: string } | null>(null);
  const [nameInput, setNameInput] = useState('');

  // Add-widget modal
  const [addOpen, setAddOpen] = useState(false);

  // Per-block config modal (section title / tile label+icon override)
  const [blockEdit, setBlockEdit] = useState<number | null>(null);
  const [cfgLabel, setCfgLabel] = useState('');
  const [cfgIcon, setCfgIcon] = useState('');
  const [cfgSection, setCfgSection] = useState('');

  // Role-picker modal
  const [rolePick, setRolePick] = useState<UserRole | null>(null);

  const editingPreset = editingId ? presets.find((p) => p.id === editingId) ?? null : null;

  function refreshPresets() {
    setPresets(getDashboardPresets());
  }

  // ── Preset list actions ─────────────────────────────────────────────────────

  function blockCount(p: DashboardPreset): number {
    return parsePresetLayout(p.layout)?.length ?? 0;
  }

  function openEditor(id: string) {
    const p = getDashboardPresetById(id);
    const layout = parsePresetLayout(p?.layout ?? null) ?? [];
    setBlocks(layout.map((block) => ({ key: generateUUID(), block })));
    setEditingId(id);
  }

  function openCreate() {
    setNameInput('');
    setNameModal({ mode: 'create' });
  }

  function openRename(p: DashboardPreset) {
    setNameInput(p.name);
    setNameModal({ mode: 'rename', id: p.id });
  }

  function submitName() {
    const name = nameInput.trim();
    if (!name) {
      Alert.alert('Required', 'Enter a name for the preset.');
      return;
    }
    try {
      if (nameModal?.mode === 'create') {
        const id = createDashboardPreset({ name });
        setNameModal(null);
        refreshPresets();
        openEditor(id);
      } else if (nameModal?.mode === 'rename' && nameModal.id) {
        renameDashboardPreset(nameModal.id, name);
        setNameModal(null);
        refreshPresets();
      }
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  }

  function handleDuplicate(p: DashboardPreset) {
    try {
      const id = createDashboardPreset({ name: `${p.name} (copy)` });
      const layout = parsePresetLayout(p.layout) ?? [];
      setDashboardPresetLayout(id, layout);
      refreshPresets();
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  }

  function handleToggleArchive(p: DashboardPreset) {
    const nextActive = p.active !== 1;
    const verb = nextActive ? 'Restore' : 'Archive';
    Alert.alert(
      `${verb} "${p.name}"?`,
      nextActive
        ? 'This preset will be available to assign again.'
        : 'This preset will be hidden. Roles/users assigned to it fall back to the built-in default.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: verb,
          style: nextActive ? 'default' : 'destructive',
          onPress: () => {
            try {
              setDashboardPresetActive(p.id, nextActive);
              refreshPresets();
            } catch (err) {
              Alert.alert('Error', (err as Error).message);
            }
          },
        },
      ],
    );
  }

  // ── Layout editor mutations (persist immediately, like manage-types) ─────────

  function persist(next: KeyedBlock[]) {
    setBlocks(next);
    if (!editingId) return;
    try {
      setDashboardPresetLayout(editingId, next.map((b) => b.block) as Layout);
      refreshPresets();
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  }

  function handleReorder(orderedKeys: string[]) {
    const byKey = new Map(blocks.map((b) => [b.key, b]));
    persist(orderedKeys.map((k) => byKey.get(k)!).filter(Boolean));
  }

  function toggleWidth(index: number) {
    persist(
      blocks.map((b, i) =>
        i === index ? { ...b, block: { ...b.block, width: b.block.width === 'full' ? 'half' : 'full' } } : b,
      ),
    );
  }

  function removeBlock(index: number) {
    persist(blocks.filter((_, i) => i !== index));
  }

  function addWidget(widget: WidgetType) {
    const block: LayoutBlock =
      widget === 'section'
        ? { widget, width: 'full', config: { sectionTitle: 'New Section' } }
        : { widget, width: 'full' };
    persist([...blocks, { key: generateUUID(), block }]);
    setAddOpen(false);
  }

  // Per-block config modal
  function openBlockConfig(index: number) {
    const b = blocks[index].block;
    setCfgLabel(b.config?.label ?? '');
    setCfgIcon(b.config?.icon ?? '');
    setCfgSection(b.config?.sectionTitle ?? '');
    setBlockEdit(index);
  }

  function saveBlockConfig() {
    if (blockEdit == null) return;
    const target = blocks[blockEdit].block;
    const config: NonNullable<LayoutBlock['config']> = {};
    if (target.widget === 'section') {
      const t = cfgSection.trim();
      if (t) config.sectionTitle = t;
    } else {
      const l = cfgLabel.trim();
      const ic = cfgIcon.trim();
      if (l) config.label = l;
      if (ic) config.icon = ic;
    }
    const hasConfig = Object.keys(config).length > 0;
    persist(
      blocks.map((b, i) =>
        i === blockEdit ? { ...b, block: { ...b.block, config: hasConfig ? config : undefined } } : b,
      ),
    );
    setBlockEdit(null);
  }

  // ── Role defaults ────────────────────────────────────────────────────────────

  function assignRole(role: UserRole, presetId: string | null) {
    try {
      setRoleDashboardPreset(role, presetId);
      setRoleMap(getRoleDashboardPresetIds());
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
    setRolePick(null);
  }

  const presetNameById = useMemo(
    () => new Map(presets.map((p) => [p.id, p.name])),
    [presets],
  );

  // ── Render guards ────────────────────────────────────────────────────────────

  if (!isTier4) {
    return (
      <>
        <Stack.Screen options={{ title: 'Dashboards', headerShown: true }} />
        <View style={s.unauthorizedWrap}>
          <Text style={s.unauthorizedText}>This screen requires Tier 4 (Owner) access.</Text>
        </View>
      </>
    );
  }

  // ── Editor view ──────────────────────────────────────────────────────────────

  if (editingId && editingPreset) {
    const blockBeingEdited = blockEdit != null ? blocks[blockEdit]?.block : null;
    return (
      <>
        <Stack.Screen options={{ title: 'Edit Layout', headerShown: true }} />
        <ScrollView style={s.container} contentContainerStyle={s.content}>
          <TouchableOpacity style={s.backRow} onPress={() => setEditingId(null)}>
            <Text style={s.backText}>‹ All presets</Text>
          </TouchableOpacity>
          <Text style={s.editorTitle}>{editingPreset.name}</Text>
          <Text style={s.rowSub}>
            {blocks.length} block{blocks.length === 1 ? '' : 's'} · changes save automatically
          </Text>

          {/* Live preview (labels in a full/half grid) */}
          {blocks.length > 0 && (
            <View style={s.section}>
              <Text style={s.sectionTitle}>Preview</Text>
              <View style={s.previewGrid}>
                {blocks.map((b) => {
                  const d = widgetDisplay(b.block);
                  const isSection = b.block.widget === 'section';
                  return (
                    <View
                      key={b.key}
                      style={[
                        s.previewCell,
                        b.block.width === 'half' ? s.previewHalf : s.previewFull,
                        isSection && s.previewSection,
                      ]}
                    >
                      <Text style={s.previewText} numberOfLines={1}>
                        {d.icon} {d.label}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </View>
          )}

          {/* Reorderable blocks */}
          <View style={s.section}>
            <Text style={s.sectionTitle}>Blocks</Text>
            <View style={s.card}>
              {blocks.length === 0 ? (
                <Text style={s.emptyText}>No blocks yet. Add a widget below.</Text>
              ) : (
                <DragList
                  items={blocks}
                  keyExtractor={(b) => b.key}
                  rowHeight={ROW_HEIGHT}
                  onReorder={handleReorder}
                  renderRow={(item, api) => {
                    const d = widgetDisplay(item.block);
                    const def = WIDGET_REGISTRY[item.block.widget];
                    const configurable = item.block.widget === 'section' || def.kind === 'tile';
                    return (
                      <View style={[s.blockRow, api.index > 0 && s.blockRowBorder]}>
                        <View
                          {...api.panHandlers}
                          style={s.dragHandle}
                          accessibilityLabel={`Drag to reorder ${d.label}`}
                        >
                          <Text style={s.dragGlyph}>≡</Text>
                        </View>
                        <Text style={s.blockIcon}>{d.icon}</Text>
                        <View style={{ flex: 1 }}>
                          <Text style={s.blockLabel} numberOfLines={1}>{d.label}</Text>
                          <Text style={s.blockMeta}>{item.block.width}</Text>
                        </View>
                        <TouchableOpacity
                          onPress={api.moveUp}
                          disabled={api.isFirst}
                          style={s.iconBtn}
                          hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                        >
                          <Text style={[s.arrow, api.isFirst && s.arrowDisabled]}>▲</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={api.moveDown}
                          disabled={api.isLast}
                          style={s.iconBtn}
                          hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                        >
                          <Text style={[s.arrow, api.isLast && s.arrowDisabled]}>▼</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => toggleWidth(api.index)} style={s.widthBtn}>
                          <Text style={s.widthBtnText}>{item.block.width === 'full' ? '½' : '▢'}</Text>
                        </TouchableOpacity>
                        {configurable && (
                          <TouchableOpacity onPress={() => openBlockConfig(api.index)} style={s.editBtn}>
                            <Text style={s.editBtnText}>Edit</Text>
                          </TouchableOpacity>
                        )}
                        <TouchableOpacity
                          onPress={() => removeBlock(api.index)}
                          style={s.iconBtn}
                          hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                        >
                          <Text style={s.removeGlyph}>×</Text>
                        </TouchableOpacity>
                      </View>
                    );
                  }}
                />
              )}
            </View>
            <TouchableOpacity style={s.addRow} onPress={() => setAddOpen(true)}>
              <Text style={s.addRowText}>+ Add widget</Text>
            </TouchableOpacity>
          </View>
        </ScrollView>

        {/* Add-widget picker */}
        <ModalSheet visible={addOpen} onClose={() => setAddOpen(false)}>
          <ScrollView contentContainerStyle={s.modalContent} keyboardShouldPersistTaps="handled">
            <Text style={s.modalTitle}>Add widget</Text>
            <Text style={s.fieldLabel}>Tiles</Text>
            <View style={s.pickGrid}>
              {TILE_WIDGETS.map((w) => (
                <TouchableOpacity key={w} style={s.pickItem} onPress={() => addWidget(w)}>
                  <Text style={s.pickIcon}>{WIDGET_REGISTRY[w].icon ?? '•'}</Text>
                  <Text style={s.pickLabel} numberOfLines={1}>{WIDGET_REGISTRY[w].label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={s.fieldLabel}>Blocks</Text>
            <View style={s.pickGrid}>
              {BLOCK_WIDGETS.map((w) => (
                <TouchableOpacity key={w} style={s.pickItem} onPress={() => addWidget(w)}>
                  <Text style={s.pickIcon}>{w === 'section' ? '▤' : '▦'}</Text>
                  <Text style={s.pickLabel} numberOfLines={1}>{BLOCK_NAMES[w] ?? w}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={s.cancelBtn} onPress={() => setAddOpen(false)}>
              <Text style={s.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </ScrollView>
        </ModalSheet>

        {/* Per-block config */}
        <ModalSheet visible={blockEdit !== null} onClose={() => setBlockEdit(null)}>
          <ScrollView contentContainerStyle={s.modalContent} keyboardShouldPersistTaps="handled">
            {blockBeingEdited && (
              <>
                <Text style={s.modalTitle}>
                  {blockBeingEdited.widget === 'section' ? 'Section header' : 'Tile overrides'}
                </Text>
                {blockBeingEdited.widget === 'section' ? (
                  <>
                    <Text style={s.fieldLabel}>Section title</Text>
                    <AppInput placeholder="e.g. Operations" value={cfgSection} onChangeText={setCfgSection} />
                  </>
                ) : (
                  <>
                    <Text style={s.fieldLabel}>Label override</Text>
                    <Text style={s.rowSub}>
                      Blank keeps the default “{WIDGET_REGISTRY[blockBeingEdited.widget].label}”.
                    </Text>
                    <AppInput placeholder="Custom label" value={cfgLabel} onChangeText={setCfgLabel} />
                    <Text style={s.fieldLabel}>Icon override</Text>
                    <Text style={s.rowSub}>Blank keeps the default icon. Paste an emoji.</Text>
                    <AppInput placeholder="🧩" value={cfgIcon} onChangeText={setCfgIcon} />
                  </>
                )}
                <PrimaryButton label="Save" onPress={saveBlockConfig} />
                <TouchableOpacity style={s.cancelBtn} onPress={() => setBlockEdit(null)}>
                  <Text style={s.cancelText}>Cancel</Text>
                </TouchableOpacity>
              </>
            )}
          </ScrollView>
        </ModalSheet>
      </>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────────

  return (
    <>
      <Stack.Screen options={{ title: 'Dashboards', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.content}>
        {/* Presets */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Presets</Text>
          <View style={s.card}>
            {presets.length === 0 ? (
              <Text style={s.emptyText}>No presets yet. Create one below.</Text>
            ) : (
              presets.map((p, i) => (
                <View key={p.id} style={[s.presetRow, i > 0 && s.blockRowBorder, p.active !== 1 && s.muted]}>
                  <TouchableOpacity style={{ flex: 1 }} onPress={() => openEditor(p.id)}>
                    <View style={s.presetTitleRow}>
                      <Text style={s.presetName} numberOfLines={1}>{p.name}</Text>
                      {p.active !== 1 && <Text style={s.archivedBadge}>archived</Text>}
                    </View>
                    <Text style={s.rowSub}>
                      {blockCount(p)} block{blockCount(p) === 1 ? '' : 's'}
                    </Text>
                  </TouchableOpacity>
                  <View style={s.presetActions}>
                    <TouchableOpacity onPress={() => openEditor(p.id)} style={s.editBtn}>
                      <Text style={s.editBtnText}>Edit</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => openRename(p)} style={s.textBtn}>
                      <Text style={s.textBtnText}>Rename</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleDuplicate(p)} style={s.textBtn}>
                      <Text style={s.textBtnText}>Duplicate</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => handleToggleArchive(p)} style={s.textBtn}>
                      <Text style={[s.textBtnText, p.active === 1 ? s.danger : s.good]}>
                        {p.active === 1 ? 'Archive' : 'Restore'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ))
            )}
          </View>
          <TouchableOpacity style={s.addRow} onPress={openCreate}>
            <Text style={s.addRowText}>+ Create Preset</Text>
          </TouchableOpacity>
        </View>

        {/* Role defaults */}
        <View style={s.section}>
          <Text style={s.sectionTitle}>Role Defaults</Text>
          <Text style={s.rowSub}>
            The dashboard each role gets by default. Per-user assignments (Users screen) override this.
          </Text>
          <View style={s.card}>
            {ROLES_ORDERED.map((role, i) => {
              const assignedId = roleMap[role] ?? null;
              const name = assignedId ? presetNameById.get(assignedId) ?? 'Unknown preset' : 'Built-in default';
              return (
                <TouchableOpacity
                  key={role}
                  style={[s.row, i > 0 && s.blockRowBorder]}
                  onPress={() => setRolePick(role)}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowLabel}>{ROLE_DISPLAY_NAMES[role]}</Text>
                    <Text style={s.rowSub}>{name}</Text>
                  </View>
                  <Text style={s.chevron}>›</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </ScrollView>

      {/* Name modal (create / rename) */}
      <ModalSheet visible={nameModal !== null} onClose={() => setNameModal(null)}>
        <ScrollView contentContainerStyle={s.modalContent} keyboardShouldPersistTaps="handled">
          <Text style={s.modalTitle}>{nameModal?.mode === 'rename' ? 'Rename Preset' : 'New Preset'}</Text>
          <AppInput
            placeholder="Preset name (e.g. Crew Home)"
            value={nameInput}
            onChangeText={setNameInput}
            autoFocus
          />
          <PrimaryButton
            label={nameModal?.mode === 'rename' ? 'Save' : 'Create & Edit'}
            onPress={submitName}
          />
          <TouchableOpacity style={s.cancelBtn} onPress={() => setNameModal(null)}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </ModalSheet>

      {/* Role preset picker */}
      <ModalSheet visible={rolePick !== null} onClose={() => setRolePick(null)}>
        <ScrollView contentContainerStyle={s.modalContent} keyboardShouldPersistTaps="handled">
          <Text style={s.modalTitle}>
            {rolePick ? ROLE_DISPLAY_NAMES[rolePick] : ''} dashboard
          </Text>
          <TouchableOpacity
            style={s.pickRow}
            onPress={() => rolePick && assignRole(rolePick, null)}
          >
            <Text style={s.pickRowText}>Built-in default</Text>
            {rolePick && !roleMap[rolePick] && <Text style={s.pickCheck}>✓</Text>}
          </TouchableOpacity>
          {presets.filter((p) => p.active === 1).map((p) => (
            <TouchableOpacity
              key={p.id}
              style={s.pickRow}
              onPress={() => rolePick && assignRole(rolePick, p.id)}
            >
              <Text style={s.pickRowText} numberOfLines={1}>{p.name}</Text>
              {rolePick && roleMap[rolePick] === p.id && <Text style={s.pickCheck}>✓</Text>}
            </TouchableOpacity>
          ))}
          <TouchableOpacity style={s.cancelBtn} onPress={() => setRolePick(null)}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </ModalSheet>
    </>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 48 },

  unauthorizedWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  unauthorizedText: { fontSize: fontSizes.body, color: colors.textSecondary, textAlign: 'center' },

  section: { gap: spacing.sm },
  sectionTitle: {
    fontSize: fontSizes.caption,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  blockRowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  emptyText: {
    textAlign: 'center',
    padding: spacing.lg,
    color: colors.textMuted,
    fontSize: fontSizes.body2,
  },
  muted: { opacity: 0.55 },

  // Preset list rows
  presetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
  },
  presetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  presetName: { fontSize: fontSizes.body, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
  presetActions: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 190 },
  archivedBadge: {
    fontSize: fontSizes.xs,
    fontWeight: '700',
    color: colors.textMuted,
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },

  // Editor
  backRow: { paddingVertical: 2 },
  backText: { fontSize: fontSizes.body, color: colors.primary, fontWeight: '600' },
  editorTitle: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.brand },

  blockRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.base,
    gap: 6,
    height: ROW_HEIGHT,
    backgroundColor: colors.surface,
  },
  dragHandle: { paddingHorizontal: 4, paddingVertical: 8 },
  dragGlyph: { fontSize: 18, color: colors.textMuted, fontWeight: '700' },
  blockIcon: { fontSize: 18, width: 24, textAlign: 'center' },
  blockLabel: { fontSize: fontSizes.body2, fontWeight: '600', color: colors.textPrimary },
  blockMeta: { fontSize: fontSizes.xs, color: colors.textMuted, textTransform: 'uppercase', marginTop: 1 },
  iconBtn: { padding: 4 },
  arrow: { fontSize: 12, color: colors.textSecondary, fontWeight: '700' },
  arrowDisabled: { color: colors.textDisabled },
  removeGlyph: { fontSize: 20, lineHeight: 20, fontWeight: '700', color: colors.danger },
  widthBtn: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  widthBtnText: { fontSize: fontSizes.body2, fontWeight: '700', color: colors.textSecondary },
  editBtn: {
    backgroundColor: colors.primaryBg,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
  },
  editBtnText: { fontSize: fontSizes.sm, fontWeight: '600', color: colors.primaryText },
  textBtn: { paddingHorizontal: 4, paddingVertical: 5 },
  textBtnText: { fontSize: fontSizes.sm, fontWeight: '600', color: colors.textSecondary },

  addRow: { alignItems: 'center', paddingVertical: spacing.md },
  addRowText: { fontSize: fontSizes.body, fontWeight: '600', color: colors.primary },

  // Preview grid
  previewGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  previewCell: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: 10,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  previewFull: { width: '100%' },
  previewHalf: { width: '48.5%' },
  previewSection: { backgroundColor: colors.primaryBg, borderColor: colors.primaryBgStrong },
  previewText: { fontSize: fontSizes.body2, fontWeight: '600', color: colors.textPrimary },

  // Generic rows
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.base,
  },
  rowLabel: { fontSize: fontSizes.body, color: colors.textPrimary, fontWeight: '500' },
  rowSub: { fontSize: fontSizes.body2, color: colors.textSecondary, marginTop: 2 },
  chevron: { fontSize: 18, color: colors.textMuted, fontWeight: '300' },
  danger: { color: colors.danger },
  good: { color: colors.success },

  // Modals
  modalContent: { gap: 12, paddingBottom: 16 },
  modalTitle: { fontSize: fontSizes.lg, fontWeight: '700', color: colors.brand, marginBottom: 4 },
  fieldLabel: {
    fontSize: fontSizes.caption,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  cancelBtn: { alignItems: 'center', paddingVertical: 10 },
  cancelText: { fontSize: fontSizes.body, color: colors.textSecondary, fontWeight: '500' },

  // Add-widget picker grid
  pickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pickItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#F1F5F9',
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minWidth: '47%',
  },
  pickIcon: { fontSize: 16 },
  pickLabel: { fontSize: fontSizes.body2, fontWeight: '600', color: colors.textSecondary, flexShrink: 1 },

  // Role preset picker rows
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  pickRowText: { fontSize: fontSizes.body, color: colors.textPrimary, fontWeight: '500', flexShrink: 1 },
  pickCheck: { fontSize: fontSizes.body, color: colors.primary, fontWeight: '800' },
});
