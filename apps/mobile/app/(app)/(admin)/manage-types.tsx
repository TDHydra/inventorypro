import { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert, Switch,
} from 'react-native';
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
} from '../../../src/db/queries/taxonomy';
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

// ── Type list row ────────────────────────────────────────────────────────────

function TypeRow({
  item,
  index,
  total,
  locked,
  onEdit,
  onMoveUp,
  onMoveDown,
}: {
  item: TaxonomyType;
  index: number;
  total: number;
  locked: boolean;
  onEdit: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  return (
    <View style={[s.typeRow, !item.active && s.typeRowMuted]}>
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
        >
          <Text style={[s.reorderArrow, (index === 0 || locked) && s.arrowDisabled]}>▲</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onMoveDown}
          disabled={index === total - 1 || locked}
          style={s.reorderBtn}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        >
          <Text style={[s.reorderArrow, (index === total - 1 || locked) && s.arrowDisabled]}>▼</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onEdit} style={[s.editBtn, locked && s.editBtnDisabled]} disabled={locked}>
          <Text style={s.editBtnText}>Edit</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

// Human-readable noun per taxonomy category (used in modal titles).
const CATEGORY_NOUN: Record<string, string> = {
  team: 'Team Type',
  job: 'Job Type',
  product_class: 'Product Class',
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

  // Add modal
  const [addCategory, setAddCategory] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newIcon, setNewIcon] = useState<string | null>(null);

  // Edit modal
  const [editType, setEditType] = useState<TaxonomyType | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editIcon, setEditIcon] = useState<string | null>(null);

  // Product-class units editor (only populated when editing a product_class)
  const [editClass, setEditClass] = useState<ProductClass | null>(null);
  const [editUnits, setEditUnits] = useState<string[]>([]);
  const [editAllowDecimals, setEditAllowDecimals] = useState(true);
  const [newUnit, setNewUnit] = useState('');

  function refresh() {
    setTeamTypes(getTaxonomyTypes('team', { includeInactive: true }));
    setJobTypes(getTaxonomyTypes('job', { includeInactive: true }));
    setClassTypes(getTaxonomyTypes('product_class', { includeInactive: true }));
  }

  // ── Add handlers ────────────────────────────────────────────────────────────

  function openAdd(category: string) {
    setAddCategory(category);
    setNewLabel('');
    setNewIcon(null);
  }

  function closeAdd() {
    setAddCategory(null);
    setNewLabel('');
    setNewIcon(null);
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
      const meta =
        addCategory === 'product_class'
          ? JSON.stringify({ units: [], allowDecimals: true })
          : undefined;
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
      setEditUnits(cls ? [...cls.units] : []);
      setEditAllowDecimals(cls ? cls.allowDecimals : true);
    } else {
      setEditClass(null);
      setEditUnits([]);
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
    setEditAllowDecimals(true);
    setNewUnit('');
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
          {list.length === 0 && (
            <Text style={s.emptyText}>No types yet. Add one below.</Text>
          )}
          {list.map((item, index) => (
            <View key={item.id}>
              {index > 0 && <View style={s.divider} />}
              <TypeRow
                item={item}
                index={index}
                total={list.length}
                locked={locked}
                onEdit={() => openEdit(item)}
                onMoveUp={() => handleMoveUp(list, index)}
                onMoveDown={() => handleMoveDown(list, index)}
              />
            </View>
          ))}
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

  const editDirty =
    !!editType &&
    (editLabel.trim() !== editType.label ||
      editIcon !== editType.icon ||
      metaDirty);

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

              {editType.category === 'product_class' && (
                <>
                  <Text style={s.fieldLabel}>Units</Text>
                  {editUnits.length === 0 ? (
                    <Text style={s.unitsEmpty}>
                      No units yet. Add curated units below.
                    </Text>
                  ) : (
                    <View style={s.unitChipWrap}>
                      {editUnits.map(unit => (
                        <View key={unit} style={s.unitChip}>
                          <Text style={s.unitChipText}>{unit}</Text>
                          <TouchableOpacity
                            onPress={() => handleRemoveUnit(unit)}
                            disabled={locked}
                            hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                          >
                            <Text style={s.unitChipRemove}>×</Text>
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
                </>
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
  unitChipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  unitChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.primaryBg,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
  },
  unitChipText: { fontSize: fontSizes.body2, fontWeight: '600', color: colors.primaryText },
  unitChipRemove: { fontSize: 18, lineHeight: 18, fontWeight: '700', color: colors.primaryText },
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
