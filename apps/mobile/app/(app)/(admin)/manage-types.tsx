import { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, StyleSheet, Alert,
} from 'react-native';
import { Stack } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { ROLE_TIER } from '../../../src/constants/roles';
import {
  TaxonomyType,
  getTaxonomyTypes,
  addTaxonomyType,
  renameTaxonomyType,
  setTaxonomyIcon,
  setTaxonomyActive,
  reorderTaxonomyType,
} from '../../../src/db/queries/taxonomy';
import { ICON_OPTIONS, renderIcon } from '../../../src/constants/locationStyles';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';

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
  onEdit,
  onMoveUp,
  onMoveDown,
}: {
  item: TaxonomyType;
  index: number;
  total: number;
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
          disabled={index === 0}
          style={s.reorderBtn}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        >
          <Text style={[s.reorderArrow, index === 0 && s.arrowDisabled]}>▲</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={onMoveDown}
          disabled={index === total - 1}
          style={s.reorderBtn}
          hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
        >
          <Text style={[s.reorderArrow, index === total - 1 && s.arrowDisabled]}>▼</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={onEdit} style={s.editBtn}>
          <Text style={s.editBtnText}>Edit</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

export default function ManageTypesScreen() {
  const { user } = useSession();
  const isTier4 = user != null && ROLE_TIER[user.role] === 4;

  const [teamTypes, setTeamTypes] = useState<TaxonomyType[]>(() =>
    getTaxonomyTypes('team', { includeInactive: true }),
  );
  const [jobTypes, setJobTypes] = useState<TaxonomyType[]>(() =>
    getTaxonomyTypes('job', { includeInactive: true }),
  );

  // Add modal
  const [addCategory, setAddCategory] = useState<string | null>(null);
  const [newLabel, setNewLabel] = useState('');
  const [newIcon, setNewIcon] = useState<string | null>(null);

  // Edit modal
  const [editType, setEditType] = useState<TaxonomyType | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editIcon, setEditIcon] = useState<string | null>(null);

  function refresh() {
    setTeamTypes(getTaxonomyTypes('team', { includeInactive: true }));
    setJobTypes(getTaxonomyTypes('job', { includeInactive: true }));
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
    const label = newLabel.trim();
    if (!label) {
      Alert.alert('Required', 'Enter a label for the new type.');
      return;
    }
    try {
      addTaxonomyType({ category: addCategory, label, icon: newIcon });
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
  }

  function closeEdit() {
    setEditType(null);
    setEditLabel('');
    setEditIcon(null);
  }

  function handleSaveEdit() {
    if (!editType) return;
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
      refresh();
      closeEdit();
    } catch (err) {
      Alert.alert('Error', (err as Error).message);
    }
  }

  function handleToggleActive() {
    if (!editType) return;
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

  function renderSection(title: string, category: string, list: TaxonomyType[]) {
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
                onEdit={() => openEdit(item)}
                onMoveUp={() => handleMoveUp(list, index)}
                onMoveDown={() => handleMoveDown(list, index)}
              />
            </View>
          ))}
        </View>
        <TouchableOpacity style={s.addRow} onPress={() => openAdd(category)}>
          <Text style={s.addRowText}>+ Add {title.replace(' Types', '')} Type</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const editDirty =
    !!editType &&
    (editLabel.trim() !== editType.label || editIcon !== editType.icon);

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
          {renderSection('Team Types', 'team', teamTypes)}
          {renderSection('Job Types', 'job', jobTypes)}
        </ScrollView>
      )}

      {/* ── Add modal ──────────────────────────────────────────────────────── */}
      <ModalSheet visible={addCategory !== null} onClose={closeAdd}>
        <ScrollView
          contentContainerStyle={s.modalContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={s.modalTitle}>
            Add {addCategory === 'team' ? 'Team' : 'Job'} Type
          </Text>
          <AppInput
            placeholder="Type label (e.g. Biohazard)"
            value={newLabel}
            onChangeText={setNewLabel}
          />
          <Text style={s.fieldLabel}>Icon</Text>
          <IconPicker selected={newIcon} onSelect={icon => setNewIcon(icon)} />
          <PrimaryButton label="Add Type" onPress={handleAdd} />
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
              <PrimaryButton
                label={editDirty ? 'Save Changes' : 'No Changes'}
                onPress={handleSaveEdit}
                disabled={!editDirty}
              />
              <TouchableOpacity
                style={[
                  s.archiveBtn,
                  editType.active ? s.archiveBtnDanger : s.archiveBtnGood,
                ]}
                onPress={handleToggleActive}
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

  emptyText: {
    textAlign: 'center', padding: spacing.lg,
    color: colors.textMuted, fontSize: fontSizes.body2,
  },

  addRow: { alignItems: 'center', paddingVertical: spacing.md },
  addRowText: { fontSize: fontSizes.body, fontWeight: '600', color: colors.primary },

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
  archiveBtnIcon: { fontSize: 20 },
  archiveBtnLabel: { fontSize: fontSizes.body, fontWeight: '600', color: colors.textPrimary },
  archiveBtnSub: { fontSize: fontSizes.sm, color: colors.textMuted, marginTop: 1 },
  dangerText: { color: colors.danger },
  goodText: { color: colors.success },

  cancelBtn: { alignItems: 'center', paddingVertical: 10 },
  cancelText: { fontSize: fontSizes.body, color: colors.textSecondary, fontWeight: '500' },
});
