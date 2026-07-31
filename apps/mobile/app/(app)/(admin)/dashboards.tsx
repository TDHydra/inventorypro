import { useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack } from 'expo-router';
import { ROLE_TIER, ROLE_DISPLAY_NAMES, type UserRole } from '../../../src/constants/roles';
import {
  WIDGET_REGISTRY,
  type WidgetType,
  type Layout,
  type LayoutBlock,
  type StatSource,
  type WorkListSource,
} from '../../../src/dashboard/widgets';
import { parsePresetLayout } from '../../../src/dashboard/resolve';
import { loadDashboardCache } from '../../../src/dashboard/store';
import { useTableVersion } from '../../../src/hooks/useDataVersion';
import { filterTilesForRoles } from '../../../src/dashboard/presetFilter';
import { roleHasPermission } from '../../../src/auth/permissions';
import { usePermission } from '../../../src/hooks/usePermission';
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
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
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

// Human-readable name for a non-tile block whose registry label is blank.
// ('search' is gone — DashboardSearch is pinned by the dashboard screen.) The
// config-driven data widgets (stat-tiles / work-list / activity-preview) carry
// real registry labels, so blockName falls back to those.
const BLOCK_NAMES: Record<string, string> = {
  section: 'Section Header',
  'quick-add': 'Quick Add CTA',
  'low-stock': 'Low-Stock List',
  // Contextual quick-actions (#144) — only render when their condition holds.
  'vehicle-checkin': 'Check-In Vehicle (contextual)',
  'past-due': 'Past Due (contextual)',
  'low-stock-catalog': 'Low-Stock Button (contextual)',
};

function blockName(widget: WidgetType): string {
  return BLOCK_NAMES[widget] ?? (WIDGET_REGISTRY[widget].label || widget);
}

// Non-tile blocks that take a config editor here (role dashboards §2: the new
// data widgets must be usable FROM the preset editor — without stats/source
// they only ever render their EmptyState).
const CONFIGURABLE_BLOCKS: ReadonlySet<WidgetType> = new Set<WidgetType>([
  'stat-tiles', 'work-list', 'activity-preview',
]);

// Source labels — keep in lockstep with STAT_DEFS in
// src/components/dashboard/StatTiles.tsx.
const STAT_SOURCE_LABELS: Record<StatSource, string> = {
  'my-checkouts': 'My Checkouts',
  'open-repairs': 'Open Repairs',
  'units-due-service': 'Due Service',
  'low-stock': 'Low Stock',
  'open-jobs': 'Open Jobs',
  'team-members': 'Team Members',
  'vehicles-available': 'Vehicles Available',
  'shared-media': 'Shared Media',
};
const STAT_SOURCES = Object.keys(STAT_SOURCE_LABELS) as StatSource[];

// Keep in lockstep with WORK_LIST_DEFS in src/components/dashboard/WorkList.tsx.
const WORK_LIST_SOURCE_LABELS: Record<WorkListSource, string> = {
  'my-equipment': 'My Equipment',
  'my-jobs': 'My Jobs',
  'open-jobs': 'Open Jobs',
  'open-repairs': 'Open Repairs',
  'units-due-service': 'Due for Service',
  'low-stock': 'Low Stock',
  vehicles: 'Vehicles',
};
const WORK_LIST_SOURCES = Object.keys(WORK_LIST_SOURCE_LABELS) as WorkListSource[];

function isStatSource(s: unknown): s is StatSource {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(STAT_SOURCE_LABELS, s);
}

function isWorkListSource(s: unknown): s is WorkListSource {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(WORK_LIST_SOURCE_LABELS, s);
}

function widgetDisplay(block: LayoutBlock): { icon: string; label: string } {
  const def = WIDGET_REGISTRY[block.widget];
  if (block.widget === 'section') {
    return { icon: '▤', label: block.config?.sectionTitle?.trim() || 'Section' };
  }
  if (def.kind === 'block') {
    return {
      icon: def.icon || '▦',
      // A configured title (work-list / activity-preview) reads better than the
      // generic registry label in the preview and block rows.
      label: block.config?.title?.trim() || blockName(block.widget),
    };
  }
  return {
    icon: block.config?.icon?.trim() || def.icon || '•',
    label: block.config?.label?.trim() || def.label,
  };
}

export default function DashboardsScreen() {
  const s = useThemedStyles(makeStyles);
  // #76: server gates dashboard_presets writes on system_settings, not a tier
  // floor — the client gate now matches (was isTier4).
  const canManageDashboards = usePermission('system_settings');

  // Re-read whenever a local write or sync pull touches the preset tables —
  // replaces the old manual refreshPresets()/setRoleMap re-reads after writes.
  const version = useTableVersion(['dashboard_presets', 'role_settings']);
  const presets = useMemo<DashboardPreset[]>(() => getDashboardPresets(), [version]);
  const roleMap = useMemo<Record<string, string | null>>(() => getRoleDashboardPresetIds(), [version]);

  // Editor state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<KeyedBlock[]>([]);
  // Disable the editor ScrollView while a block is being dragged so the reorder
  // gesture doesn't fight the parent scroll.
  const [dragActive, setDragActive] = useState(false);

  // Name modal (create / rename)
  const [nameModal, setNameModal] = useState<{ mode: 'create' | 'rename'; id?: string } | null>(null);
  const [nameInput, setNameInput] = useState('');

  // Add-widget modal
  const [addOpen, setAddOpen] = useState(false);

  // Per-block config modal (section title / tile label+icon override / data
  // widget stats+source+title+limit)
  const [blockEdit, setBlockEdit] = useState<number | null>(null);
  const [cfgLabel, setCfgLabel] = useState('');
  const [cfgIcon, setCfgIcon] = useState('');
  const [cfgSection, setCfgSection] = useState('');
  const [cfgStats, setCfgStats] = useState<StatSource[]>([]);
  const [cfgSource, setCfgSource] = useState<WorkListSource | null>(null);
  const [cfgTitle, setCfgTitle] = useState('');
  const [cfgLimit, setCfgLimit] = useState('');

  // Role-picker modal
  const [rolePick, setRolePick] = useState<UserRole | null>(null);

  const editingPreset = editingId ? presets.find((p) => p.id === editingId) ?? null : null;

  // Roles currently assigned to the preset being edited — the add-widget picker
  // offers only tiles every one of them passes (requiredPermission).
  const assignedRoles = useMemo(
    () => Object.entries(roleMap).filter(([, id]) => id === editingId).map(([role]) => role),
    [roleMap, editingId],
  );
  const offeredTiles = filterTilesForRoles(
    TILE_WIDGETS, assignedRoles,
    (role, perm) => roleHasPermission(role as UserRole, perm),
  );
  const hiddenTileCount = TILE_WIDGETS.length - offeredTiles.length;

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
        openEditor(id);
      } else if (nameModal?.mode === 'rename' && nameModal.id) {
        renameDashboardPreset(nameModal.id, name);
        setNameModal(null);
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
    setCfgStats(Array.isArray(b.config?.stats) ? b.config.stats.filter(isStatSource) : []);
    setCfgSource(isWorkListSource(b.config?.source) ? b.config.source : null);
    setCfgTitle(b.config?.title ?? '');
    setCfgLimit(typeof b.config?.limit === 'number' && b.config.limit > 0 ? String(b.config.limit) : '');
    setBlockEdit(index);
  }

  // Toggle a stat source in/out; toggle order = tile order on the dashboard.
  function toggleStat(src: StatSource) {
    setCfgStats(prev => (prev.includes(src) ? prev.filter(s => s !== src) : [...prev, src]));
  }

  function saveBlockConfig() {
    if (blockEdit == null) return;
    const target = blocks[blockEdit].block;
    const config: NonNullable<LayoutBlock['config']> = {};
    if (target.widget === 'section') {
      const t = cfgSection.trim();
      if (t) config.sectionTitle = t;
    } else if (target.widget === 'stat-tiles') {
      if (cfgStats.length > 0) config.stats = cfgStats;
    } else if (target.widget === 'work-list' || target.widget === 'activity-preview') {
      if (target.widget === 'work-list' && cfgSource) config.source = cfgSource;
      const t = cfgTitle.trim();
      if (t) config.title = t;
      const n = parseInt(cfgLimit, 10);
      if (Number.isFinite(n) && n > 0) config.limit = n;
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
      loadDashboardCache(); // notify subscribers → the assigner's own dashboard updates live
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

  if (!canManageDashboards) {
    return (
      <>
        <Stack.Screen options={{ title: 'Dashboards', headerShown: true }} />
        <View style={s.unauthorizedWrap}>
          <Text style={s.unauthorizedText}>This screen requires the "Change system settings" permission.</Text>
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
        <ScrollView style={s.container} contentContainerStyle={s.content} scrollEnabled={!dragActive}>
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
                  onDragActiveChange={setDragActive}
                  renderRow={(item, api) => {
                    const d = widgetDisplay(item.block);
                    const def = WIDGET_REGISTRY[item.block.widget];
                    const configurable =
                      item.block.widget === 'section' ||
                      def.kind === 'tile' ||
                      CONFIGURABLE_BLOCKS.has(item.block.widget);
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
              {offeredTiles.map((w) => (
                <TouchableOpacity key={w} style={s.pickItem} onPress={() => addWidget(w)}>
                  <Text style={s.pickIcon}>{WIDGET_REGISTRY[w].icon ?? '•'}</Text>
                  <Text style={s.pickLabel} numberOfLines={1}>{WIDGET_REGISTRY[w].label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {hiddenTileCount > 0 && (
              <Text style={s.pickNote}>
                {hiddenTileCount} widget{hiddenTileCount === 1 ? '' : 's'} hidden — the assigned
                role{assignedRoles.length === 1 ? ' doesn’t' : 's don’t'} have permission for {hiddenTileCount === 1 ? 'it' : 'them'}.
              </Text>
            )}
            <Text style={s.fieldLabel}>Blocks</Text>
            <View style={s.pickGrid}>
              {BLOCK_WIDGETS.map((w) => (
                <TouchableOpacity key={w} style={s.pickItem} onPress={() => addWidget(w)}>
                  <Text style={s.pickIcon}>
                    {w === 'section' ? '▤' : WIDGET_REGISTRY[w].icon || '▦'}
                  </Text>
                  <Text style={s.pickLabel} numberOfLines={1}>{blockName(w)}</Text>
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
                  {blockBeingEdited.widget === 'section'
                    ? 'Section header'
                    : CONFIGURABLE_BLOCKS.has(blockBeingEdited.widget)
                      ? blockName(blockBeingEdited.widget)
                      : 'Tile overrides'}
                </Text>
                {blockBeingEdited.widget === 'section' ? (
                  <>
                    <Text style={s.fieldLabel}>Section title</Text>
                    <AppInput placeholder="e.g. Operations" value={cfgSection} onChangeText={setCfgSection} />
                  </>
                ) : blockBeingEdited.widget === 'stat-tiles' ? (
                  <>
                    <Text style={s.fieldLabel}>Stat sources</Text>
                    <Text style={s.rowSub}>
                      Pick the count cards to show, in tap order (2–4 works best). Each card only
                      renders for users with permission to see its data.
                    </Text>
                    <View style={s.pickGrid}>
                      {STAT_SOURCES.map((src) => (
                        <FilterChip
                          key={src}
                          label={STAT_SOURCE_LABELS[src]}
                          active={cfgStats.includes(src)}
                          onPress={() => toggleStat(src)}
                        />
                      ))}
                    </View>
                  </>
                ) : blockBeingEdited.widget === 'work-list' || blockBeingEdited.widget === 'activity-preview' ? (
                  <>
                    {blockBeingEdited.widget === 'work-list' && (
                      <>
                        <Text style={s.fieldLabel}>List source</Text>
                        <View style={s.pickGrid}>
                          {WORK_LIST_SOURCES.map((src) => (
                            <FilterChip
                              key={src}
                              label={WORK_LIST_SOURCE_LABELS[src]}
                              active={cfgSource === src}
                              onPress={() => setCfgSource(src)}
                            />
                          ))}
                        </View>
                      </>
                    )}
                    <Text style={s.fieldLabel}>Title override</Text>
                    <Text style={s.rowSub}>Blank keeps the default title.</Text>
                    <AppInput placeholder="Custom title" value={cfgTitle} onChangeText={setCfgTitle} />
                    <Text style={s.fieldLabel}>Row limit</Text>
                    <Text style={s.rowSub}>How many rows to show. Blank keeps the default.</Text>
                    <AppInput
                      placeholder="5"
                      value={cfgLimit}
                      onChangeText={setCfgLimit}
                      keyboardType="number-pad"
                      style={{ width: 100 }}
                    />
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

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.lg, gap: t.spacing.lg, paddingBottom: 48 },

  unauthorizedWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.spacing.xl },
  unauthorizedText: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, textAlign: 'center' },

  section: { gap: t.spacing.sm },
  sectionTitle: {
    fontSize: t.typography.fontSizes.caption,
    fontWeight: '700',
    color: t.colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  card: {
    backgroundColor: t.colors.surface,
    borderRadius: t.radii.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
    overflow: 'hidden',
  },
  blockRowBorder: { borderTopWidth: 1, borderTopColor: t.colors.border },
  emptyText: {
    textAlign: 'center',
    padding: t.spacing.lg,
    color: t.colors.textMuted,
    fontSize: t.typography.fontSizes.body2,
  },
  muted: { opacity: 0.55 },

  // Preset list rows
  presetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: t.spacing.base,
    paddingVertical: t.spacing.md,
  },
  presetTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  presetName: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.textPrimary, flexShrink: 1 },
  presetActions: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end', maxWidth: 190 },
  archivedBadge: {
    fontSize: t.typography.fontSizes.xs,
    fontWeight: '700',
    color: t.colors.textMuted,
    backgroundColor: t.colors.surfaceAlt,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },

  // Editor
  backRow: { paddingVertical: 2 },
  backText: { fontSize: t.typography.fontSizes.body, color: t.colors.primary, fontWeight: '600' },
  editorTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.brand },

  blockRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: t.spacing.base,
    gap: 6,
    height: ROW_HEIGHT,
    backgroundColor: t.colors.surface,
  },
  dragHandle: { paddingHorizontal: 4, paddingVertical: 8 },
  dragGlyph: { fontSize: 18, color: t.colors.textMuted, fontWeight: '700' },
  blockIcon: { fontSize: 18, width: 24, textAlign: 'center' },
  blockLabel: { fontSize: t.typography.fontSizes.body2, fontWeight: '600', color: t.colors.textPrimary },
  blockMeta: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted, textTransform: 'uppercase', marginTop: 1 },
  iconBtn: { padding: 4 },
  arrow: { fontSize: 12, color: t.colors.textSecondary, fontWeight: '700' },
  arrowDisabled: { color: t.colors.textDisabled },
  removeGlyph: { fontSize: 20, lineHeight: 20, fontWeight: '700', color: t.colors.danger },
  widthBtn: {
    borderWidth: 1,
    borderColor: t.colors.border,
    borderRadius: t.radii.sm,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  widthBtnText: { fontSize: t.typography.fontSizes.body2, fontWeight: '700', color: t.colors.textSecondary },
  editBtn: {
    backgroundColor: t.colors.primaryBg,
    borderRadius: t.radii.sm,
    paddingHorizontal: t.spacing.sm,
    paddingVertical: 5,
  },
  editBtnText: { fontSize: t.typography.fontSizes.sm, fontWeight: '600', color: t.colors.primaryText },
  textBtn: { paddingHorizontal: 4, paddingVertical: 5 },
  textBtnText: { fontSize: t.typography.fontSizes.sm, fontWeight: '600', color: t.colors.textSecondary },

  addRow: { alignItems: 'center', paddingVertical: t.spacing.md },
  addRowText: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.primary },

  // Preview grid
  previewGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  previewCell: {
    backgroundColor: t.colors.surface,
    borderWidth: 1,
    borderColor: t.colors.border,
    borderRadius: t.radii.sm,
    paddingHorizontal: 10,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  previewFull: { width: '100%' },
  previewHalf: { width: '48.5%' },
  previewSection: { backgroundColor: t.colors.primaryBg, borderColor: t.colors.primaryBgStrong },
  previewText: { fontSize: t.typography.fontSizes.body2, fontWeight: '600', color: t.colors.textPrimary },

  // Generic rows
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.base,
    paddingVertical: t.spacing.base,
  },
  rowLabel: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, fontWeight: '500' },
  rowSub: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, marginTop: 2 },
  chevron: { fontSize: 18, color: t.colors.textMuted, fontWeight: '300' },
  danger: { color: t.colors.danger },
  good: { color: t.colors.success },

  // Modals
  modalContent: { gap: 12, paddingBottom: 16 },
  modalTitle: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.brand, marginBottom: 4 },
  fieldLabel: {
    fontSize: t.typography.fontSizes.caption,
    fontWeight: '600',
    color: t.colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  cancelBtn: { alignItems: 'center', paddingVertical: 10 },
  cancelText: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary, fontWeight: '500' },

  // Add-widget picker grid
  pickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pickItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: t.colors.surfaceAlt,
    borderRadius: t.radii.md,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.sm,
    minWidth: '47%',
  },
  pickIcon: { fontSize: 16 },
  pickLabel: { fontSize: t.typography.fontSizes.body2, fontWeight: '600', color: t.colors.textSecondary, flexShrink: 1 },
  pickNote: { fontSize: 12, color: t.colors.textMuted, marginTop: 8 },

  // Role preset picker rows
  pickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: t.spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: t.colors.border,
  },
  pickRowText: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, fontWeight: '500', flexShrink: 1 },
  pickCheck: { fontSize: t.typography.fontSizes.body, color: t.colors.primary, fontWeight: '800' },
});
