import { useMemo, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Switch, Animated, PanResponder } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { ROLE_TIER } from '../../../src/constants/roles';
import {
  TaxonomyType,
  ProductClass,
  getTaxonomyTypes,
  getProductClassById,
  setClassMeta,
  addTaxonomyType,
  renameTaxonomyType,
  setTaxonomyIcon,
  setTaxonomyActive,
  reorderTaxonomyType,
  parseItemTypeMeta,
  setTaxonomyUnits,
  setTaxonomyClassId,
  setTaxonomyTerminal,
  setTaxonomyColor,
} from '../../../src/db/queries/taxonomy';
import {
  TYPE_COLOR_PALETTE,
  autoTypeColor,
  resolveTypeColor,
} from '../../../src/constants/typeColors';
import { loadClassConfigCache } from '../../../src/constants/units';
import { ICON_OPTIONS, renderIcon } from '../../../src/constants/locationStyles';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { MaintenanceBanner } from '../../../src/components/ui/MaintenanceBanner';

// ── Icon picker ──────────────────────────────────────────────────────────────

function IconPicker({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (icon: string) => void;
}) {
  return (
    <View style={s.iconGrid}>
      {ICON_OPTIONS.map(icon => (
        <FilterChip
          key={icon}
          label={icon}
          active={selected === icon}
          onPress={() => onSelect(icon)}
        />
      ))}
    </View>
  );
}

// ── Color picker ─────────────────────────────────────────────────────────────
// Row of palette swatches (the palette is dark → used as badge bg with white
// text in lists). The selected swatch shows a white check. `selected` is the
// EFFECTIVE color (override or auto default) so the active default reads clearly.

function ColorPicker({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (color: string) => void;
}) {
  const sel = selected?.toLowerCase();
  return (
    <View style={s.colorGrid}>
      {TYPE_COLOR_PALETTE.map(color => {
        const active = sel === color.toLowerCase();
        return (
          <TouchableOpacity
            key={color}
            onPress={() => onSelect(color)}
            style={[s.colorSwatch, { backgroundColor: color }, active && s.colorSwatchActive]}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
          >
            {active && <Text style={s.colorSwatchCheck}>✓</Text>}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

// ── Type list row (drag-to-reorder) ──────────────────────────────────────────
// Rows are absolutely positioned inside DraggableTypeList so a lifted row can
// float under the finger via a shared Animated.Value while the others shift to
// open a gap. A ≡ grab handle owns a PanResponder; the up/down arrows remain as
// a no-drag accessibility fallback.

const ROW_HEIGHT = 54;

function DragRow({
  item,
  index,
  total,
  dragging,
  shift,
  dragY,
  locked,
  onEdit,
  onDragStart,
  onDragMove,
  onDragEnd,
  onMoveUp,
  onMoveDown,
}: {
  item: TaxonomyType;
  index: number;
  total: number;
  dragging: boolean;
  shift: number;
  dragY: Animated.Value;
  locked: boolean;
  onEdit: () => void;
  onDragStart: (index: number) => void;
  onDragMove: (index: number, dy: number) => void;
  onDragEnd: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  // Mirror per-render values into a ref so the PanResponder (created once) always
  // reads this row's current index / locked flag / callbacks.
  const cfg = useRef({ index, locked, onDragStart, onDragMove, onDragEnd });
  cfg.current = { index, locked, onDragStart, onDragMove, onDragEnd };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !cfg.current.locked,
        onMoveShouldSetPanResponder: () => !cfg.current.locked,
        onPanResponderGrant: () => cfg.current.onDragStart(cfg.current.index),
        onPanResponderMove: (_e, g) => cfg.current.onDragMove(cfg.current.index, g.dy),
        onPanResponderRelease: () => cfg.current.onDragEnd(),
        onPanResponderTerminate: () => cfg.current.onDragEnd(),
      }),
    [],
  );

  const transform = dragging ? [{ translateY: dragY }] : [{ translateY: shift }];

  return (
    <Animated.View
      style={[
        s.dragRow,
        index > 0 && s.dragRowBorder,
        !item.active && s.typeRowMuted,
        { top: index * ROW_HEIGHT, transform },
        dragging && s.dragRowLifted,
      ]}
    >
      <View
        {...responder.panHandlers}
        style={s.dragHandle}
        accessibilityLabel={`Drag to reorder ${item.label}`}
      >
        <Text style={[s.dragHandleGlyph, locked && s.arrowDisabled]}>≡</Text>
      </View>
      <Text style={s.typeRowIcon}>{renderIcon(item.icon)}</Text>
      <Text style={[s.typeRowLabel, !item.active && s.typeRowLabelMuted]} numberOfLines={1}>
        {item.label}
      </Text>
      {!item.active && <Text style={s.archivedBadge}>archived</Text>}
      <View style={s.typeRowActions}>
        <TouchableOpacity
          onPress={onMoveUp}
          disabled={index === 0 || locked}
          style={s.reorderBtn}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          accessibilityLabel="Move up"
        >
          <Text style={[s.reorderArrow, (index === 0 || locked) && s.arrowDisabled]}>▲</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onMoveDown}
          disabled={index === total - 1 || locked}
          style={s.reorderBtn}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
          accessibilityLabel="Move down"
        >
          <Text style={[s.reorderArrow, (index === total - 1 || locked) && s.arrowDisabled]}>▼</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onEdit} style={[s.editBtn, locked && s.editBtnDisabled]} disabled={locked}>
          <Text style={s.editBtnText}>Edit</Text>
        </TouchableOpacity>
      </View>
    </Animated.View>
  );
}

function DraggableTypeList({
  list,
  locked,
  onEdit,
  onReorder,
  onMoveUp,
  onMoveDown,
}: {
  list: TaxonomyType[];
  locked: boolean;
  onEdit: (item: TaxonomyType) => void;
  onReorder: (orderedIds: string[]) => void;
  onMoveUp: (index: number) => void;
  onMoveDown: (index: number) => void;
}) {
  const dragY = useRef(new Animated.Value(0)).current;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [targetIndex, setTargetIndex] = useState<number | null>(null);
  // Ref mirrors for use inside the release/terminate closures (avoid stale state).
  const dragIndexRef = useRef<number | null>(null);
  const targetIndexRef = useRef<number | null>(null);
  const lenRef = useRef(list.length);
  lenRef.current = list.length;

  function handleDragStart(index: number) {
    dragIndexRef.current = index;
    targetIndexRef.current = index;
    setDragIndex(index);
    setTargetIndex(index);
    dragY.setValue(0);
  }

  function handleDragMove(startIndex: number, dy: number) {
    dragY.setValue(dy);
    const raw = startIndex + Math.round(dy / ROW_HEIGHT);
    const clamped = Math.max(0, Math.min(lenRef.current - 1, raw));
    if (clamped !== targetIndexRef.current) {
      targetIndexRef.current = clamped;
      setTargetIndex(clamped);
    }
  }

  function handleDragEnd() {
    const from = dragIndexRef.current;
    const to = targetIndexRef.current;
    dragIndexRef.current = null;
    targetIndexRef.current = null;
    setDragIndex(null);
    setTargetIndex(null);
    dragY.setValue(0);
    if (from == null || to == null || from === to) return;
    const ids = list.map(t => t.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    onReorder(ids);
  }

  // Vertical offset for a non-dragged row so the list opens a gap at the target.
  function slotShift(i: number): number {
    if (dragIndex == null || targetIndex == null || i === dragIndex) return 0;
    if (dragIndex < targetIndex && i > dragIndex && i <= targetIndex) return -ROW_HEIGHT;
    if (dragIndex > targetIndex && i >= targetIndex && i < dragIndex) return ROW_HEIGHT;
    return 0;
  }

  return (
    <View style={[s.dragList, { height: list.length * ROW_HEIGHT }]}>
      {list.map((item, i) => (
        <DragRow
          key={item.id}
          item={item}
          index={i}
          total={list.length}
          dragging={dragIndex === i}
          shift={slotShift(i)}
          dragY={dragY}
          locked={locked}
          onEdit={() => onEdit(item)}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
          onMoveUp={() => onMoveUp(i)}
          onMoveDown={() => onMoveDown(i)}
        />
      ))}
    </View>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

// Human-readable noun per taxonomy category (used in modal titles).
const CATEGORY_NOUN: Record<string, string> = {
  team: 'Team Type',
  job: 'Job Type',
  product_class: 'Product Class',
  item_category: 'Item Type',
  location_type: 'Location Type',
  repair_status: 'Repair Status',
};

export default function ManageTypesScreen() {
  const { user } = useSession();
  const isTier4 = user != null && ROLE_TIER[user.role] === 4;
  const { locked } = useMaintenanceMode();

  const [teamTypes, setTeamTypes] = useState<TaxonomyType[]>(() =>
    getTaxonomyTypes('team', { includeInactive: true }),
  );
  const [jobTypes, setJobTypes] = useState<TaxonomyType[]>(() =>
    getTaxonomyTypes('job', { includeInactive: true }),
  );
  const [classTypes, setClassTypes] = useState<TaxonomyType[]>(() =>
    getTaxonomyTypes('product_class', { includeInactive: true }),
  );
  const [itemCatTypes, setItemCatTypes] = useState<TaxonomyType[]>(() =>
    getTaxonomyTypes('item_category', { includeInactive: true }),
  );
  const [locTypes, setLocTypes] = useState<TaxonomyType[]>(() =>
    getTaxonomyTypes('location_type', { includeInactive: true }),
  );
  const [repairStatuses, setRepairStatuses] = useState<TaxonomyType[]>(() =>
    getTaxonomyTypes('repair_status', { includeInactive: true }),
  );

  // Add modal
  const [addCategory, setAddCategory] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newIcon, setNewIcon] = useState<string | null>(null);
  // Optional color pick for new Item Types (null → auto color applies).
  const [newColor, setNewColor] = useState<string | null>(null);

  // Edit modal
  const [editType, setEditType] = useState<TaxonomyType | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editIcon, setEditIcon] = useState<string | null>(null);
  // Item Type color override (null → falls back to the auto/default color).
  const [editColorOverride, setEditColorOverride] = useState<string | null>(null);

  // Product-class units editor (only populated when editing a product_class)
  const [editClass, setEditClass] = useState<ProductClass | null>(null);
  const [editUnits, setEditUnits] = useState<string[]>([]);
  const [editUnitsOriginal, setEditUnitsOriginal] = useState<string[]>([]);
  const [editAllowDecimals, setEditAllowDecimals] = useState(true);
  const [newUnit, setNewUnit] = useState('');
  // Item-type unit-class mapping (item_category.meta.classId).
  const [editClassId, setEditClassId] = useState<string>('');
  const [editClassIdOriginal, setEditClassIdOriginal] = useState<string>('');
  // Repair-status terminal flag ("counts as completed").
  const [editTerminal, setEditTerminal] = useState(false);
  const [editTerminalOriginal, setEditTerminalOriginal] = useState(false);

  function refresh() {
    setTeamTypes(getTaxonomyTypes('team', { includeInactive: true }));
    setJobTypes(getTaxonomyTypes('job', { includeInactive: true }));
    setClassTypes(getTaxonomyTypes('product_class', { includeInactive: true }));
    setItemCatTypes(getTaxonomyTypes('item_category', { includeInactive: true }));
    setLocTypes(getTaxonomyTypes('location_type', { includeInactive: true }));
    setRepairStatuses(getTaxonomyTypes('repair_status', { includeInactive: true }));
  }

  // ── Add handlers ────────────────────────────────────────────────────────────

  function openAdd(category: string) {
    setAddCategory(category);
    setNewLabel('');
    setNewIcon(null);
    setNewColor(null);
  }

  function closeAdd() {
    setAddCategory(null);
    setNewLabel('');
    setNewIcon(null);
    setNewColor(null);
  }

  function handleAdd() {
    if (!addCategory) return;
    if (isWriteBlocked()) return;
    const label = newLabel.trim();
    if (!label) {
      Alert.alert('Required', 'Enter a label for the new type.');
      return;
    }
    try {
      // New product classes seed empty curated units + decimals allowed.
      // New Item Types optionally carry a pinned color (omit → auto applies).
      let meta: string | undefined;
      if (addCategory === 'product_class') {
        meta = JSON.stringify({ units: [], allowDecimals: true });
      } else if (addCategory === 'item_category' && newColor) {
        meta = JSON.stringify({ color: newColor });
      }
      addTaxonomyType({ category: addCategory, label, icon: newIcon, meta });
      if (addCategory === 'product_class') loadClassConfigCache();
      refresh();
      closeAdd();
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  }

  // ── Edit handlers ───────────────────────────────────────────────────────────

  function openEdit(item: TaxonomyType) {
    setEditType(item);
    setEditLabel(item.label);
    setEditIcon(item.icon);
    if (item.category === 'product_class') {
      const cls = getProductClassById(item.id);
      setEditClass(cls);
      const units = cls ? [...cls.units] : [];
      setEditUnits(units);
      setEditUnitsOriginal(units);
      setEditAllowDecimals(cls ? cls.allowDecimals : true);
    } else if (item.category === 'item_category') {
      const m = parseItemTypeMeta(item.meta);
      setEditClass(null);
      setEditUnits([...m.units]);
      setEditUnitsOriginal([...m.units]);
      setEditAllowDecimals(true);
      setEditClassId(m.classId ?? '');
      setEditClassIdOriginal(m.classId ?? '');
      setEditColorOverride(m.color);
    } else if (item.category === 'repair_status') {
      setEditClass(null);
      setEditUnits([]);
      setEditUnitsOriginal([]);
      setEditAllowDecimals(true);
      let terminal = false;
      try { terminal = JSON.parse(item.meta || '{}').terminal === true; } catch { terminal = false; }
      setEditTerminal(terminal);
      setEditTerminalOriginal(terminal);
    } else {
      setEditClass(null);
      setEditUnits([]);
      setEditUnitsOriginal([]);
      setEditAllowDecimals(true);
    }
    setNewUnit('');
  }

  function closeEdit() {
    setEditType(null);
    setEditLabel('');
    setEditIcon(null);
    setEditClass(null);
    setEditUnits([]);
    setEditUnitsOriginal([]);
    setEditAllowDecimals(true);
    setNewUnit('');
    setEditClassId('');
    setEditClassIdOriginal('');
    setEditTerminal(false);
    setEditTerminalOriginal(false);
    setEditColorOverride(null);
  }

  function handleMoveUnitUp(index: number) {
    if (index <= 0) return;
    setEditUnits(prev => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  }

  function handleMoveUnitDown(index: number) {
    setEditUnits(prev => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index + 1], next[index]] = [next[index], next[index + 1]];
      return next;
    });
  }

  function handleAddUnit() {
    const u = newUnit.trim();
    if (!u) return;
    setNewUnit('');
    if (editUnits.includes(u)) return;
    setEditUnits([...editUnits, u]);
  }

  function handleRemoveUnit(unit: string) {
    setEditUnits(editUnits.filter(u => u !== unit));
  }

  // Item Type color override applies immediately (no Save needed), then re-pulls
  // the list so the stored meta.color is reflected.
  function handlePickColor(color: string) {
    if (!editType) return;
    if (isWriteBlocked()) return;
    try {
      setTaxonomyColor(editType.id, color);
      setEditColorOverride(color);
      refresh();
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  }

  function handleResetColor() {
    if (!editType) return;
    if (isWriteBlocked()) return;
    try {
      setTaxonomyColor(editType.id, null);
      setEditColorOverride(null);
      refresh();
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  }

  function handleSaveEdit() {
    if (!editType) return;
    if (isWriteBlocked()) return;
    const label = editLabel.trim();
    if (!label) {
      Alert.alert('Required', 'Label cannot be empty.');
      return;
    }
    try {
      if (label !== editType.label) {
        renameTaxonomyType(editType.id, label);
      }
      if (editIcon !== editType.icon) {
        setTaxonomyIcon(editType.id, editIcon);
      }
      if (editType.category === 'product_class' && metaDirty) {
        setClassMeta(editType.id, {
          units: editUnits,
          allowDecimals: editAllowDecimals,
        });
        // Refresh the decimals cache so formatQuantity() reflects the change now.
        loadClassConfigCache();
      } else if (editType.category === 'item_category') {
        // Persist units (preserves classId) and/or the class mapping (preserves
        // units), independently.
        if (unitsDirty) setTaxonomyUnits(editType.id, editUnits);
        if (classIdDirty && editClassId) {
          setTaxonomyClassId(editType.id, editClassId);
          loadClassConfigCache();
        }
      } else if (editType.category === 'repair_status' && terminalDirty) {
        setTaxonomyTerminal(editType.id, editTerminal);
      }
      refresh();
      closeEdit();
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  }

  function handleToggleActive() {
    if (!editType) return;
    if (isWriteBlocked()) return;
    const nextActive = !editType.active;
    const verb = nextActive ? 'Restore' : 'Archive';
    Alert.alert(
      `${verb} "${editType.label}"?`,
      nextActive
        ? 'This type will become available in pickers again.'
        : 'This type will be hidden from pickers. Existing records are not affected.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: verb,
          style: nextActive ? 'default' : 'destructive',
          onPress: () => {
            try {
              setTaxonomyActive(editType.id, nextActive);
              refresh();
              closeEdit();
            } catch (err) {
              Alert.alert('Error', (err as Error).message);
            }
          },
        },
      ],
    );
  }

  // ── Reorder handlers ────────────────────────────────────────────────────────

  function handleMoveUp(list: TaxonomyType[], index: number) {
    if (index === 0) return;
    if (isWriteBlocked()) return;
    const current = list[index];
    const above = list[index - 1];
    try {
      reorderTaxonomyType(current.id, above.sort_order);
      reorderTaxonomyType(above.id, current.sort_order);
      refresh();
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  }

  function handleMoveDown(list: TaxonomyType[], index: number) {
    if (index === list.length - 1) return;
    if (isWriteBlocked()) return;
    const current = list[index];
    const below = list[index + 1];
    try {
      reorderTaxonomyType(current.id, below.sort_order);
      reorderTaxonomyType(below.id, current.sort_order);
      refresh();
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  }

  // Commit a drag-reorder: keep the category's existing set of sort_order values
  // and reassign them by the new row position (list arrives sorted ascending),
  // persisting only the rows whose sort_order actually changed.
  function handleReorderCommit(list: TaxonomyType[], orderedIds: string[]) {
    if (isWriteBlocked()) return;
    const orders = list.map(t => t.sort_order);
    const byId = new Map(list.map(t => [t.id, t]));
    try {
      orderedIds.forEach((id, i) => {
        const t = byId.get(id);
        if (t && t.sort_order !== orders[i]) reorderTaxonomyType(id, orders[i]);
      });
      refresh();
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  }

  // ── Section renderer ────────────────────────────────────────────────────────

  function renderSection(
    title: string,
    category: string,
    list: TaxonomyType[],
    addLabel: string,
  ) {
    return (
      <View style={s.section}>
        <Text style={s.sectionTitle}>{title}</Text>
        <View style={s.card}>
          {list.length === 0 ? (
            <Text style={s.emptyText}>No types yet. Add one below.</Text>
          ) : (
            <DraggableTypeList
              list={list}
              locked={locked}
              onEdit={openEdit}
              onReorder={ids => handleReorderCommit(list, ids)}
              onMoveUp={i => handleMoveUp(list, i)}
              onMoveDown={i => handleMoveDown(list, i)}
            />
          )}
        </View>
        <TouchableOpacity
          style={s.addRow}
          onPress={() => openAdd(category)}
          disabled={locked}
        >
          <Text style={[s.addRowText, locked && s.addRowTextDisabled]}>{addLabel}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const metaDirty =
    !!editClass &&
    (editAllowDecimals !== editClass.allowDecimals ||
      editUnits.length !== editClass.units.length ||
      editUnits.some((u, i) => u !== editClass.units[i]));

  const unitsDirty =
    editUnits.length !== editUnitsOriginal.length ||
    editUnits.some((u, i) => u !== editUnitsOriginal[i]);

  const classIdDirty =
    editType?.category === 'item_category' && editClassId !== editClassIdOriginal;

  const terminalDirty =
    editType?.category === 'repair_status' && editTerminal !== editTerminalOriginal;

  const editDirty =
    !!editType &&
    (editLabel.trim() !== editType.label ||
      editIcon !== editType.icon ||
      metaDirty ||
      unitsDirty ||
      classIdDirty ||
      terminalDirty);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <>
      <Stack.Screen options={{ title: 'Manage Types', headerShown: true }} />

      {!isTier4 ? (
        <View style={s.unauthorizedWrap}>
          <Text style={s.unauthorizedText}>
            This screen requires Tier 4 (Owner) access.
          </Text>
        </View>
      ) : (
        <ScrollView style={s.container} contentContainerStyle={s.content}>
          {locked && <MaintenanceBanner />}
          {renderSection('Team Types', 'team', teamTypes, '+ Add Team Type')}
          {renderSection('Job Types', 'job', jobTypes, '+ Add Job Type')}
          {renderSection('Product Classes', 'product_class', classTypes, '+ Add Product Class')}
          {renderSection('Item Types', 'item_category', itemCatTypes, '+ Add Item Type')}
          {renderSection('Location Types', 'location_type', locTypes, '+ Add Location Type')}
          {renderSection('Repair Statuses', 'repair_status', repairStatuses, '+ Add Repair Status')}
        </ScrollView>
      )}

      {/* ── Add modal ──────────────────────────────────────────────────────── */}
      <ModalSheet visible={addCategory !== null} onClose={closeAdd}>
        <ScrollView
          contentContainerStyle={s.modalContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={s.modalTitle}>
            Add {addCategory ? CATEGORY_NOUN[addCategory] ?? 'Type' : 'Type'}
          </Text>
          <AppInput
            placeholder="Type label (e.g. Biohazard)"
            value={newLabel}
            onChangeText={setNewLabel}
          />
          <Text style={s.fieldLabel}>Icon</Text>
          <IconPicker selected={newIcon} onSelect={icon => setNewIcon(icon)} />
          {addCategory === 'item_category' && (
            <>
              <Text style={s.fieldLabel}>Color</Text>
              <Text style={s.rowSub}>
                Optional. Tap a swatch to pin a color for this type in lists.
                Leave unset to use the automatic color
                {newLabel.trim() ? '' : ' (assigned from the name)'}.
              </Text>
              <ColorPicker
                selected={newColor ?? (newLabel.trim() ? autoTypeColor(newLabel) : null)}
                onSelect={color => setNewColor(c => (c === color ? null : color))}
              />
            </>
          )}
          <PrimaryButton label="Add Type" onPress={handleAdd} disabled={locked} />
          <TouchableOpacity style={s.cancelBtn} onPress={closeAdd}>
            <Text style={s.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </ModalSheet>

      {/* ── Edit modal ─────────────────────────────────────────────────────── */}
      <ModalSheet visible={editType !== null} onClose={closeEdit}>
        <ScrollView
          contentContainerStyle={s.modalContent}
          keyboardShouldPersistTaps="handled"
        >
          {editType && (
            <>
              <Text style={s.modalTitle}>Edit Type</Text>
              <Text style={s.fieldLabel}>Label</Text>
              <AppInput
                placeholder="Label"
                value={editLabel}
                onChangeText={setEditLabel}
              />
              <Text style={s.fieldLabel}>Icon</Text>
              <IconPicker selected={editIcon} onSelect={icon => setEditIcon(icon)} />

              {(editType.category === 'product_class' ||
                editType.category === 'item_category') && (
                <>
                  <Text style={s.fieldLabel}>Units</Text>
                  {editUnits.length === 0 ? (
                    <Text style={s.unitsEmpty}>
                      No units yet. Add curated units below.
                    </Text>
                  ) : (
                    <View style={s.unitList}>
                      {editUnits.map((unit, index) => (
                        <View key={unit} style={s.unitListRow}>
                          <Text style={s.unitListText} numberOfLines={1}>
                            {unit}
                          </Text>
                          <TouchableOpacity
                            onPress={() => handleMoveUnitUp(index)}
                            disabled={locked || index === 0}
                            style={s.unitReorderBtn}
                            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                          >
                            <Text
                              style={[
                                s.unitReorderArrow,
                                (locked || index === 0) && s.arrowDisabled,
                              ]}
                            >
                              ▲
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => handleMoveUnitDown(index)}
                            disabled={locked || index === editUnits.length - 1}
                            style={s.unitReorderBtn}
                            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                          >
                            <Text
                              style={[
                                s.unitReorderArrow,
                                (locked || index === editUnits.length - 1) && s.arrowDisabled,
                              ]}
                            >
                              ▼
                            </Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => handleRemoveUnit(unit)}
                            disabled={locked}
                            style={s.unitReorderBtn}
                            hitSlop={{ top: 6, bottom: 6, left: 4, right: 4 }}
                          >
                            <Text style={s.unitListRemove}>×</Text>
                          </TouchableOpacity>
                        </View>
                      ))}
                    </View>
                  )}
                  <View style={s.addUnitRow}>
                    <View style={{ flex: 1 }}>
                      <AppInput
                        placeholder="Add a unit (e.g. each)"
                        value={newUnit}
                        onChangeText={setNewUnit}
                        onSubmitEditing={handleAddUnit}
                        editable={!locked}
                        autoCapitalize="none"
                      />
                    </View>
                    <TouchableOpacity
                      style={[s.addUnitBtn, (locked || !newUnit.trim()) && s.addUnitBtnDisabled]}
                      onPress={handleAddUnit}
                      disabled={locked || !newUnit.trim()}
                    >
                      <Text style={s.addUnitBtnText}>Add</Text>
                    </TouchableOpacity>
                  </View>
                  {editType.category === 'product_class' && (
                    <View style={s.decimalsRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={s.rowLabel}>Allow decimals</Text>
                        <Text style={s.rowSub}>
                          Permit fractional quantities (e.g. 1.5) for this class.
                        </Text>
                      </View>
                      <Switch
                        value={editAllowDecimals}
                        onValueChange={setEditAllowDecimals}
                        disabled={locked}
                      />
                    </View>
                  )}
                  {editType.category === 'item_category' && (
                    <>
                      <Text style={s.fieldLabel}>Unit class</Text>
                      <Text style={s.rowSub}>
                        Sets how quantities format (e.g. liquid allows decimals). New
                        items of this type default to its unit list above.
                      </Text>
                      <View style={s.classChipRow}>
                        {classTypes.filter(c => c.active === 1).map(c => (
                          <FilterChip
                            key={c.id}
                            label={c.label}
                            active={editClassId === c.id}
                            onPress={() => setEditClassId(c.id)}
                          />
                        ))}
                      </View>

                      <View style={s.colorHeaderRow}>
                        <Text style={s.fieldLabel}>Color</Text>
                        {editColorOverride != null && (
                          <TouchableOpacity
                            onPress={handleResetColor}
                            disabled={locked}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          >
                            <Text style={[s.resetColorText, locked && s.addRowTextDisabled]}>
                              Reset to default
                            </Text>
                          </TouchableOpacity>
                        )}
                      </View>
                      <Text style={s.rowSub}>
                        {editColorOverride != null
                          ? 'Pinned color used for this type in lists. Tap another swatch to change.'
                          : 'Using the automatic color (from the name). Tap a swatch to pin one.'}
                      </Text>
                      <ColorPicker
                        selected={resolveTypeColor(editType.label, editColorOverride)}
                        onSelect={handlePickColor}
                      />
                    </>
                  )}
                </>
              )}

              {editType.category === 'repair_status' && (
                <View style={s.decimalsRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowLabel}>Counts as completed</Text>
                    <Text style={s.rowSub}>
                      Repairs set to this status are treated as done (move out of the
                      open queue).
                    </Text>
                  </View>
                  <Switch
                    value={editTerminal}
                    onValueChange={setEditTerminal}
                    disabled={locked}
                  />
                </View>
              )}

              <PrimaryButton
                label={editDirty ? 'Save Changes' : 'No Changes'}
                onPress={handleSaveEdit}
                disabled={!editDirty || locked}
              />
              <TouchableOpacity
                style={[
                  s.archiveBtn,
                  editType.active ? s.archiveBtnDanger : s.archiveBtnGood,
                  locked && s.archiveBtnLocked,
                ]}
                onPress={handleToggleActive}
                disabled={locked}
              >
                <Text style={s.archiveBtnIcon}>{editType.active ? '🗄️' : '✅'}</Text>
                <View style={{ flex: 1 }}>
                  <Text
                    style={[
                      s.archiveBtnLabel,
                      editType.active ? s.dangerText : s.goodText,
                    ]}
                  >
                    {editType.active ? 'Archive' : 'Restore'}
                  </Text>
                  <Text style={s.archiveBtnSub}>
                    {editType.active
                      ? 'Hide from pickers (existing records unaffected)'
                      : 'Make available in pickers again'}
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity style={s.cancelBtn} onPress={closeEdit}>
                <Text style={s.cancelText}>Close</Text>
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </ModalSheet>
    </>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 48 },

  unauthorizedWrap: {
    flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl,
  },
  unauthorizedText: {
    fontSize: fontSizes.body, color: colors.textSecondary, textAlign: 'center',
  },

  // Sections
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
  divider: { height: 1, backgroundColor: colors.border, marginHorizontal: spacing.base },

  // Type row
  typeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
    gap: 10,
  },
  typeRowMuted: { opacity: 0.55 },
  typeRowIcon: { fontSize: 20, width: 28, textAlign: 'center' },
  typeRowLabel: {
    flex: 1, fontSize: fontSizes.body, fontWeight: '500', color: colors.textPrimary,
  },
  typeRowLabelMuted: { color: colors.textMuted },
  archivedBadge: {
    fontSize: fontSizes.xs,
    fontWeight: '700',
    color: colors.textMuted,
    backgroundColor: '#F1F5F9',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  typeRowActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },

  // Drag-to-reorder type list (absolutely-positioned rows within a fixed height)
  dragList: { position: 'relative' },
  dragRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.base,
    gap: 8,
    backgroundColor: colors.surface,
  },
  dragRowBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  dragRowLifted: {
    zIndex: 10,
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  dragHandle: { paddingHorizontal: 4, paddingVertical: 8, marginRight: 2 },
  dragHandleGlyph: { fontSize: 18, color: colors.textMuted, fontWeight: '700' },

  reorderBtn: { padding: 4 },
  reorderArrow: { fontSize: 12, color: colors.textSecondary, fontWeight: '700' },
  arrowDisabled: { color: colors.textDisabled },
  editBtn: {
    backgroundColor: colors.primaryBg,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 5,
    marginLeft: 4,
  },
  editBtnText: { fontSize: fontSizes.sm, fontWeight: '600', color: colors.primaryText },
  editBtnDisabled: { opacity: 0.4 },

  emptyText: {
    textAlign: 'center', padding: spacing.lg,
    color: colors.textMuted, fontSize: fontSizes.body2,
  },

  addRow: { alignItems: 'center', paddingVertical: spacing.md },
  addRowText: { fontSize: fontSizes.body, fontWeight: '600', color: colors.primary },
  addRowTextDisabled: { color: colors.textDisabled },

  // Product-class units editor
  unitsEmpty: { fontSize: fontSizes.body2, color: colors.textMuted },
  classChipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },

  // Reorderable units list
  unitList: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  unitListRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.base,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  unitListText: {
    flex: 1,
    fontSize: fontSizes.body2,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  unitReorderBtn: { padding: 4 },
  unitReorderArrow: { fontSize: 13, color: colors.textSecondary, fontWeight: '700' },
  unitListRemove: { fontSize: 18, lineHeight: 18, fontWeight: '700', color: colors.danger },
  addUnitRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  addUnitBtn: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingHorizontal: spacing.base,
    paddingVertical: 12,
  },
  addUnitBtnDisabled: { opacity: 0.4 },
  addUnitBtnText: { fontSize: fontSizes.body2, fontWeight: '700', color: colors.surface },
  decimalsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: spacing.sm,
  },
  rowLabel: { fontSize: fontSizes.body, fontWeight: '600', color: colors.textPrimary },
  rowSub: { fontSize: fontSizes.sm, color: colors.textMuted, marginTop: 1 },

  // Modal
  modalContent: { gap: 12, paddingBottom: 16 },
  modalTitle: {
    fontSize: fontSizes.lg, fontWeight: '700', color: colors.brand, marginBottom: 4,
  },
  fieldLabel: {
    fontSize: fontSizes.caption,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },

  // Icon picker (FilterChip grid)
  iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },

  // Color picker (palette swatches)
  colorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: spacing.xs },
  colorSwatch: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorSwatchActive: { borderColor: colors.textPrimary },
  colorSwatchCheck: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  colorHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  resetColorText: { fontSize: fontSizes.sm, fontWeight: '600', color: colors.primary },

  // Archive / restore action button
  archiveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.background,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  archiveBtnDanger: { borderColor: '#FECACA', backgroundColor: '#FEF2F2' },
  archiveBtnGood: { borderColor: '#BBF7D0', backgroundColor: '#F0FDF4' },
  archiveBtnLocked: { opacity: 0.4 },
  archiveBtnIcon: { fontSize: 20 },
  archiveBtnLabel: { fontSize: fontSizes.body, fontWeight: '600', color: colors.textPrimary },
  archiveBtnSub: { fontSize: fontSizes.sm, color: colors.textMuted, marginTop: 1 },
  dangerText: { color: colors.danger },
  goodText: { color: colors.success },

  cancelBtn: { alignItems: 'center', paddingVertical: 10 },
  cancelText: { fontSize: fontSizes.body, color: colors.textSecondary, fontWeight: '500' },
});
