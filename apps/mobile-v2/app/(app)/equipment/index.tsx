import { useState, useMemo, useCallback } from 'react';
import {
  View, Text, FlatList, StyleSheet,
  TouchableOpacity, RefreshControl,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { getEquipmentModels } from '../../../src/repos/equipment';
import type { EquipmentModel } from '../../../src/repos/equipment';
import { updateItemFields, getDistinctValues, upsertItem } from '../../../src/repos/items';
import type { InventoryItem } from '../../../src/repos/items';
import { appendLog } from '../../../src/db/queries/log';
import { generateUUID } from '../../../src/utils/uuid';
import { PRODUCT_CLASS_IDS } from '../../../src/constants/units';
import { TaxonomyChips } from '../../../src/components/pickers';
import { HidableField } from '../../../src/components/ui/HidableField';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { validateName, validateText } from '../../../src/lib/validation';
import { Alert } from '@invenpro/ui';
import type { Theme } from '@invenpro/ui';
import {
  useTheme, useThemedStyles, useMultiSelect, BulkActionBar, type BulkAction,
  Card, EmptyState, ModalSheet, SearchHeader, StatusBadge, TypeBadge, Fab,
  FieldLabel, TextField, PrimaryButton, MaintenanceBanner,
} from '@invenpro/ui';
import { useDbQuery, syncNow } from '@invenpro/core';

// Slimmed from apps/mobile/app/(app)/(equipment)/index.tsx (364 ln). Cut this
// wave: MediaThumbnail (TODO(wave-media)), label printing/BatchLabelPrintSheet
// (labels infra — src/labels/printLabel, LabelItem — isn't ported to v2 this
// wave; report as a gap). Reload/refresh-on-focus boilerplate is replaced by a
// reactive useDbQuery keyed on the tables the list depends on (matches
// ItemCard.tsx's idiom) instead of the old load()/useFocusEffect/refreshKey
// triple. "Add equipment" no longer routes to a full add.tsx screen — the old
// app's add.tsx flow is replaced by an inline "New model" modal here (model
// creation only; bulk unit creation is EquipmentQuickAdd, already ported) —
// see the module doc comment on the modal below for why.
export default function EquipmentScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const router = useRouter();
  const canAdd = usePermission('add_inventory');
  const canEdit = usePermission('edit_inventory');
  const { realUser } = useSession();
  const { locked } = useMaintenanceMode();
  const ms = useMultiSelect<EquipmentModel>();
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [newModelOpen, setNewModelOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  // Reactive: re-queries whenever a local write or sync pull touches equipment
  // models/units, or the search text changes — replaces the old load()/
  // useState(models)/useFocusEffect(refreshKey) triple.
  const models = useDbQuery(
    () => getEquipmentModels(query.trim() || undefined),
    [query],
    ['inventory_items', 'equipment_units'],
  );

  const categoryOptions = useMemo<PickerOption[]>(
    () => getDistinctValues('category').map(v => ({ id: v, label: v })),
    [models],
  );
  const supplierOptions = useMemo<PickerOption[]>(
    () => getDistinctValues('supplier').map(v => ({ id: v, label: v })),
    [models],
  );

  // Equipment models are inventory_items (kind='equipment'); the detail screen
  // logs their edits with entity_type 'item', so mirror that for batch changes.
  const logItem = useCallback((id: string, note: string) => {
    appendLog({
      action: 'item_updated', entity_type: 'item', entity_id: id,
      user_id: realUser?.id ?? null, note,
      team_id: null, from_location_id: null, to_location_id: null,
      quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
    });
  }, [realUser?.id]);

  // updateItemFields now self-mirrors to the outbox (repos/items.ts routes it
  // through itemsRepo.update()) — no separate appendOutbox call needed here
  // (the old app hand-rolled that pair at this exact call site).
  const applyCategory = useCallback((category: string) => {
    setCategoryPickerOpen(false);
    if (isWriteBlocked()) return;
    const value = category.trim();
    if (!value) return;
    for (const id of Array.from(ms.selected)) {
      updateItemFields(id, { category: value });
      logItem(id, `Category → ${value}`);
    }
    ms.exit();
  }, [ms, logItem]);

  const applySupplier = useCallback((supplier: string) => {
    setSupplierPickerOpen(false);
    if (isWriteBlocked()) return;
    const value = supplier.trim();
    if (!value) return;
    for (const id of Array.from(ms.selected)) {
      updateItemFields(id, { supplier: value });
      logItem(id, `Supplier → ${value}`);
    }
    ms.exit();
  }, [ms, logItem]);

  const bulkActions = useMemo<BulkAction[]>(() => [
    { key: 'category', label: 'Set category', onPress: () => setCategoryPickerOpen(true) },
    { key: 'supplier', label: 'Set supplier', onPress: () => setSupplierPickerOpen(true) },
  ], []);

  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — local (reactive) data still fresh */ }
    setRefreshing(false);
  }, [refreshing]);

  return (
    <>
      <Stack.Screen options={{ title: 'Equipment', headerShown: true }} />
      <View style={s.container}>

        <View style={s.searchRow}>
          <View style={s.searchBoxWrap}>
            <SearchHeader
              value={query}
              onChange={setQuery}
              placeholder="Search equipment..."
              debounceMs={200}
            />
          </View>
          {canAdd && (
            <TouchableOpacity
              style={s.headerAddBtn}
              onPress={() => setNewModelOpen(true)}
              accessibilityLabel="Add equipment model"
            >
              <Text style={s.headerAddText}>＋</Text>
            </TouchableOpacity>
          )}
        </View>

        <FlatList
          data={models}
          keyExtractor={m => m.id}
          renderItem={({ item: m }) => {
            const selected = ms.isSelected(m.id);
            return (
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => {
                if (ms.active) { ms.toggle(m.id); return; }
                router.push({ pathname: '/(app)/equipment/[id]', params: { id: m.id } });
              }}
              onLongPress={() => { if (canEdit && !ms.active) ms.enter(m.id); }}
              delayLongPress={300}
            >
              <Card style={[s.card, ms.active && selected && s.cardSelected]}>
                <View style={s.row}>
                  {ms.active && (
                    <View style={[s.checkbox, selected && s.checkboxOn]}>
                      {selected && <Text style={s.checkMark}>✓</Text>}
                    </View>
                  )}
                  {/* TODO(wave-media): MediaThumbnail not ported yet (excluded this wave). */}
                  <View style={s.info}>
                    <Text style={s.name} numberOfLines={1}>{m.name}</Text>
                    {/* Faithful port: the old screen badges off m.category, not
                        m.type, even though equipment models set `type` (the
                        equipment taxonomy) and typically leave `category`
                        null — so this badge rarely shows for models created
                        via the old add flow. Preserved as-is (not our call to
                        silently change on a "keep identical behavior" port). */}
                    {!!m.category && (
                      <View style={s.catRow}>
                        <TypeBadge type={m.category} />
                      </View>
                    )}
                    <View style={s.chips}>
                      {m.counts.available > 0 && (
                        <StatusBadge label={`${m.counts.available} avail`} tone="success" />
                      )}
                      {m.counts.deployed > 0 && (
                        <StatusBadge label={`${m.counts.deployed} out`} tone="primary" />
                      )}
                      {m.counts.in_repair > 0 && (
                        <StatusBadge label={`${m.counts.in_repair} repair`} tone="warning" />
                      )}
                      {m.counts.available + m.counts.deployed +
                        m.counts.in_repair + m.counts.retired === 0 && (
                        <Text style={s.noUnits}>No units</Text>
                      )}
                    </View>
                  </View>
                  <Text style={s.chevron}>›</Text>
                </View>
              </Card>
            </TouchableOpacity>
            );
          }}
          style={s.list}
          contentContainerStyle={[s.listContent, ms.active && s.listContentSelecting]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={t.colors.primary}
              colors={[t.colors.primary]}
            />
          }
          ListEmptyComponent={
            <EmptyState
              title="No equipment models"
              subtitle={
                query
                  ? `No equipment matching "${query}"`
                  : 'Add your first equipment model to get started.'
              }
              cta={
                canAdd
                  ? { label: '＋ Add Equipment', onPress: () => setNewModelOpen(true) }
                  : undefined
              }
            />
          }
        />

        {canAdd && !ms.active && (
          <Fab onPress={() => setNewModelOpen(true)} label="Add" />
        )}

        {canEdit && ms.active && (
          <BulkActionBar
            count={ms.count}
            actions={bulkActions}
            onSelectAll={() => ms.selectAll(models.map(m => m.id))}
            onCancel={ms.exit}
            disabled={locked}
          />
        )}

        {/* Bulk: set category (free entry allowed) */}
        <ModalSheet visible={categoryPickerOpen} onClose={() => setCategoryPickerOpen(false)}>
          <Text style={s.sheetTitle}>Set category for {ms.count} model{ms.count === 1 ? '' : 's'}</Text>
          <SearchablePicker
            placeholder="Search or type a category…"
            options={categoryOptions}
            value={null}
            onSelect={(opt) => applyCategory(opt.id)}
            onCreate={(text) => applyCategory(text)}
          />
        </ModalSheet>

        {/* Bulk: set supplier (free entry allowed) */}
        <ModalSheet visible={supplierPickerOpen} onClose={() => setSupplierPickerOpen(false)}>
          <Text style={s.sheetTitle}>Set supplier for {ms.count} model{ms.count === 1 ? '' : 's'}</Text>
          <SearchablePicker
            placeholder="Search or type a supplier…"
            options={supplierOptions}
            value={null}
            onSelect={(opt) => applySupplier(opt.id)}
            onCreate={(text) => applySupplier(text)}
          />
        </ModalSheet>

        <NewEquipmentModelSheet
          visible={newModelOpen}
          onClose={() => setNewModelOpen(false)}
          locked={locked}
        />
      </View>
    </>
  );
}

// ── New equipment model (replaces the old add.tsx's model-creation half) ────
//
// The old add.tsx (425 ln) did TWO things in one screen: create the catalog
// model row AND optionally seed it with initial units. Per docs/REBUILD-
// PORTING.md, add.tsx is not ported as a route — src/components/quickadd/
// EquipmentQuickAdd.tsx is the designated replacement. But EquipmentQuickAdd
// only ADDS UNITS to an EXISTING unit-tracked item (its item picker is scoped
// to unit_tracked=1 items); it has no path to create a brand-new equipment
// catalog row. That's a real gap between "what add.tsx did" and "what the
// sheet covers" — reported here rather than silently dropped, and folded into
// this index screen (not into EquipmentQuickAdd, which is a shared component
// this wave doesn't own). Bulk unit creation itself is NOT re-implemented
// here — EquipmentQuickAdd already covers it once the model exists, and the
// detail screen's "+ Add Units" covers it per-model.
function NewEquipmentModelSheet({ visible, onClose, locked }: { visible: boolean; onClose: () => void; locked: boolean }) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { realUser } = useSession();
  const [name, setName] = useState('');
  const [type, setType] = useState<string | null>(null);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [tagPrefix, setTagPrefix] = useState('');
  const [nameError, setNameError] = useState('');

  function reset() {
    setName(''); setType(null); setTypeId(null); setTagPrefix(''); setNameError('');
  }

  function handleClose() {
    reset();
    onClose();
  }

  function handleSave() {
    if (isWriteBlocked()) return;
    const nameResult = validateName(name, { label: 'Equipment name' });
    if (!nameResult.ok) { setNameError(nameResult.error); return; }
    const prefixResult = validateText(tagPrefix, { label: 'Tag prefix', max: 20 });
    if (!prefixResult.ok) { Alert.alert('Invalid tag prefix', prefixResult.error); return; }
    setNameError('');

    const id = generateUUID();
    const now = new Date().toISOString();
    const item: InventoryItem = {
      id,
      name: nameResult.value,
      barcode: null,
      description: null,
      sku: null,
      supplier: null,
      model: null,
      kind: 'equipment',
      category: null,
      type,
      type_id: typeId,
      returnable: 1,
      unit_tracked: 1,
      tag_prefix: prefixResult.value || null,
      // Stable Pieces class id (not the legacy 'piece' enum — 012 only remaps existing rows).
      unit_category: PRODUCT_CLASS_IDS.piece,
      unit: 'each',
      min_qty_alert: 0,
      reorder_to: null,
      active: 1,
      updated_at: now,
      synced_at: null,
      home_location_id: null,
      pack_size: null,
    };

    // upsertItem self-mirrors to the outbox (itemsRepo.insert()) — no manual
    // appendOutbox call, unlike the old add.tsx call site.
    upsertItem(item);
    appendLog({
      action: 'item_created', entity_type: 'item', entity_id: id,
      user_id: realUser?.id ?? null, note: nameResult.value,
      team_id: null, from_location_id: null, to_location_id: null,
      quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
    });

    reset();
    onClose();
    // Straight into the new model's detail screen, whose "+ Add Units" picks
    // up exactly where the old add.tsx's inline unit rows left off.
    router.push({ pathname: '/(app)/equipment/[id]', params: { id } });
  }

  return (
    <ModalSheet visible={visible} onClose={handleClose} scroll>
      <Text style={s.modalTitle}>New Equipment Model</Text>
      <View style={{ marginTop: 14, gap: 10 }}>
        <TextField
          label="Name"
          required
          placeholder="e.g. Air Mover, Dehumidifier 70pt"
          value={name}
          onChangeText={t => { setName(t); if (nameError) setNameError(''); }}
          autoFocus
        />
        {!!nameError && <Text style={s.errorText}>{nameError}</Text>}

        <HidableField fieldId="equipment.type">
          <View style={s.fieldWrap}>
            <TaxonomyChips
              category="equipment"
              label="Type"
              withFallback
              deselectable
              valueId={typeId}
              valueLabel={type}
              onChange={v => { setType(v.label); setTypeId(v.id); }}
            />
          </View>
        </HidableField>

        <HidableField fieldId="equipment.tag_prefix">
          <TextField
            label="Asset Tag Prefix (optional)"
            placeholder="e.g. AM-, DH-, MSC-"
            value={tagPrefix}
            onChangeText={setTagPrefix}
            autoCapitalize="characters"
          />
        </HidableField>
      </View>

      <View style={[s.row, { marginTop: 16 }]}>
        <TouchableOpacity style={[s.btn, s.btnGhost]} onPress={handleClose}>
          <Text style={s.btnGhostText}>Cancel</Text>
        </TouchableOpacity>
        <PrimaryButton label="Save Equipment Model" onPress={handleSave} disabled={locked} style={{ flex: 1 }} />
      </View>
      {locked && <MaintenanceBanner />}
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  searchRow: {
    flexDirection: 'row', gap: 10, padding: t.spacing.md, paddingBottom: t.spacing.sm,
  },
  searchBoxWrap: { flex: 1, justifyContent: 'center' },
  headerAddBtn: {
    width: 44, height: 44, backgroundColor: t.colors.primary, borderRadius: t.radii.md,
    alignItems: 'center', justifyContent: 'center',
  },
  headerAddText: { fontSize: 24, color: t.colors.onPrimary, lineHeight: 28 },
  list: { flex: 1 },
  listContent: { padding: t.spacing.md, paddingBottom: 96 },
  listContentSelecting: { paddingBottom: 180 },
  card: { marginBottom: t.spacing.sm },
  cardSelected: { borderColor: t.colors.primary, backgroundColor: t.colors.primaryBg },
  checkbox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 2,
    borderColor: t.colors.textDisabled, alignItems: 'center', justifyContent: 'center',
    backgroundColor: t.colors.surface,
  },
  checkboxOn: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
  checkMark: { color: t.colors.surface, fontSize: 13, fontWeight: '800', lineHeight: 16 },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 12 },
  modalTitle: { fontSize: 18, fontWeight: '700', color: t.colors.brand },
  row: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  fieldWrap: { gap: 6 },
  btn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', flex: 1 },
  btnGhost: { backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.textDisabled },
  btnGhostText: { color: '#475569', fontWeight: '600', fontSize: 16 },
  errorText: { fontSize: t.typography.fontSizes.caption, color: t.colors.danger, marginTop: -4 },
  info: { flex: 1, gap: 4 },
  name: { fontSize: t.typography.fontSizes.body, fontWeight: '700', color: t.colors.textPrimary },
  catRow: { flexDirection: 'row' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  noUnits: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, fontStyle: 'italic' },
  chevron: { fontSize: 22, color: t.colors.textMuted },
});
