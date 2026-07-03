import { useState, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TextInput, FlatList, StyleSheet,
  TouchableOpacity, RefreshControl,
} from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import { getEquipmentModels } from '../../../src/db/queries/equipment';
import type { EquipmentModel } from '../../../src/db/queries/equipment';
import { updateItemFields, getDistinctValues } from '../../../src/db/queries/items';
import { appendOutbox } from '../../../src/sync/outbox';
import { appendLog } from '../../../src/db/queries/log';
import { MediaThumbnail } from '../../../src/components/MediaThumbnail';
import { Card } from '../../../src/components/ui/Card';
import { EmptyState } from '../../../src/components/ui/EmptyState';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { useFocusRefresh } from '../../../src/hooks/useFocusRefresh';
import { useDataVersion } from '../../../src/hooks/useDataVersion';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { useMultiSelect } from '../../../src/hooks/useMultiSelect';
import { BulkActionBar, BulkAction } from '../../../src/components/BulkActionBar';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { syncNow } from '../../../src/sync/engine';
import { LabelItem } from '../../../src/labels/printLabel';
import { BatchLabelPrintSheet } from '../../../src/components/BatchLabelPrintSheet';
import { Alert } from '../../../src/lib/themedAlert';
import { autoTypeColor } from '../../../src/constants/typeColors';
import { colors, spacing, fontSizes, radii } from '../../../src/theme';

export default function EquipmentScreen() {
  const router = useRouter();
  const canAdd = usePermission('add_inventory');
  const canEdit = usePermission('edit_inventory');
  const { user } = useSession();
  const { locked } = useMaintenanceMode();
  const ms = useMultiSelect<EquipmentModel>();
  const refreshKey = useFocusRefresh();
  const dataVersion = useDataVersion();
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [batchLabels, setBatchLabels] = useState<LabelItem[] | null>(null);
  const [query, setQuery] = useState('');
  const [models, setModels] = useState<EquipmentModel[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Ref so useFocusEffect can always read the latest query without re-registering
  const queryRef = useRef('');
  queryRef.current = query;

  const load = useCallback((q?: string) => {
    setModels(getEquipmentModels(q));
  }, []);

  const reloadList = useCallback(() => {
    load(queryRef.current.trim() || undefined);
  }, [load]);

  // ── Bulk multi-select (gated on edit_inventory, matching the detail edit) ──
  const categoryOptions = useMemo<PickerOption[]>(
    () => getDistinctValues('category').map(v => ({ id: v, label: v })),
    [refreshKey],
  );
  const supplierOptions = useMemo<PickerOption[]>(
    () => getDistinctValues('supplier').map(v => ({ id: v, label: v })),
    [refreshKey],
  );

  // Equipment models are inventory_items (kind='equipment'); the detail screen logs
  // their edits with entity_type 'item', so mirror that for batch catalog changes.
  const logItem = useCallback((id: string, note: string) => {
    appendLog({
      action: 'item_updated', entity_type: 'item', entity_id: id,
      user_id: user?.id ?? null, note,
      team_id: null, from_location_id: null, to_location_id: null,
      quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
    });
  }, [user?.id]);

  // Mirror equipment/[id].tsx: updateItemFields then appendOutbox the returned
  // {id,...fields,updated_at}. returnable is untouched here, so no bool fix.
  const applyCategory = useCallback((category: string) => {
    setCategoryPickerOpen(false);
    if (isWriteBlocked()) return;
    const value = category.trim();
    if (!value) return;
    for (const id of Array.from(ms.selected)) {
      const synced = updateItemFields(id, { category: value });
      appendOutbox('UPDATE', 'inventory_items', synced);
      logItem(id, `Category → ${value}`);
    }
    reloadList();
    ms.exit();
  }, [ms, reloadList, logItem]);

  const applySupplier = useCallback((supplier: string) => {
    setSupplierPickerOpen(false);
    if (isWriteBlocked()) return;
    const value = supplier.trim();
    if (!value) return;
    for (const id of Array.from(ms.selected)) {
      const synced = updateItemFields(id, { supplier: value });
      appendOutbox('UPDATE', 'inventory_items', synced);
      logItem(id, `Supplier → ${value}`);
    }
    reloadList();
    ms.exit();
  }, [ms, reloadList, logItem]);

  // Offline QR-label batch print. Selected ids are always within the loaded
  // `models` list (toggle/selectAll only source from it), so we resolve
  // titles/codes from memory — no DB round-trip. Equipment models are
  // inventory_items, so the scan payload is `INV:item:{id}` (same as the detail
  // screen's model label). Printing is read-only — exempt from the write block.
  const handlePrintLabels = useCallback(() => {
    const byId = new Map(models.map(m => [m.id, m]));
    const labels: LabelItem[] = Array.from(ms.selected)
      .map(id => byId.get(id))
      .filter((m): m is EquipmentModel => !!m)
      .map(m => ({ title: m.name, code: m.barcode ?? m.id, payload: `INV:item:${m.id}` }));
    if (labels.length === 0) { ms.exit(); return; }
    // Open the chooser (presets + custom designed templates); print happens there.
    setBatchLabels(labels);
  }, [models, ms]);

  const bulkActions = useMemo<BulkAction[]>(() => [
    { key: 'print', label: 'Print labels', onPress: () => { void handlePrintLabels(); } },
    { key: 'category', label: 'Set category', onPress: () => setCategoryPickerOpen(true) },
    { key: 'supplier', label: 'Set supplier', onPress: () => setSupplierPickerOpen(true) },
  ], [handlePrintLabels]);

  // Load on mount, on screen focus (e.g. returning from add or detail), and
  // whenever a background sync pull applies changes (dataVersion bumps) while
  // this screen is focused — so an already-open list refreshes without the
  // user pulling to refresh.
  useFocusEffect(
    useCallback(() => {
      load(queryRef.current.trim() || undefined);
    }, [load, dataVersion]),
  );

  const handleSearch = (text: string) => {
    setQuery(text);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      load(text.trim() || undefined);
    }, 200);
  };

  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — local reload still runs */ }
    load(queryRef.current.trim() || undefined);
    setRefreshing(false);
  }, [refreshing, load]);

  return (
    <>
      <Stack.Screen options={{ title: 'Equipment', headerShown: true }} />
      <View style={s.container}>

        <View style={s.searchRow}>
          <View style={s.searchBox}>
            <Text style={s.searchIcon}>🔍</Text>
            <TextInput
              style={s.searchInput}
              placeholder="Search equipment..."
              placeholderTextColor={colors.textMuted}
              value={query}
              onChangeText={handleSearch}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
          </View>
          {canAdd && (
            <TouchableOpacity
              style={s.headerAddBtn}
              onPress={() => router.push('/(app)/(equipment)/add')}
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
            const catColor = autoTypeColor(m.category);
            return (
            <TouchableOpacity
              activeOpacity={0.8}
              onPress={() => {
                if (ms.active) { ms.toggle(m.id); return; }
                router.push({ pathname: '/(app)/(equipment)/[id]', params: { id: m.id } });
              }}
              onLongPress={() => { if (canEdit && !ms.active) ms.enter(m.id); }}
              delayLongPress={300}
            >
              <Card style={[s.card, ms.active && selected && s.cardSelected]}>
                <View style={s.row}>
                  <View style={[s.accent, { backgroundColor: catColor }]} />
                  {ms.active && (
                    <View style={[s.checkbox, selected && s.checkboxOn]}>
                      {selected && <Text style={s.checkMark}>✓</Text>}
                    </View>
                  )}
                  <MediaThumbnail entityType="item" entityId={m.id} size={44} />
                  <View style={s.info}>
                    <Text style={s.name} numberOfLines={1}>{m.name}</Text>
                    {!!m.category && (
                      <View style={s.catRow}>
                        <View style={[s.catBadge, { backgroundColor: catColor }]}>
                          <Text style={s.catBadgeText} numberOfLines={1}>{m.category}</Text>
                        </View>
                      </View>
                    )}
                    <View style={s.chips}>
                      {m.counts.available > 0 && (
                        <View style={[s.chip, s.chipAvail]}>
                          <Text style={s.chipText}>{m.counts.available} avail</Text>
                        </View>
                      )}
                      {m.counts.deployed > 0 && (
                        <View style={[s.chip, s.chipDeploy]}>
                          <Text style={s.chipText}>{m.counts.deployed} out</Text>
                        </View>
                      )}
                      {m.counts.in_repair > 0 && (
                        <View style={[s.chip, s.chipRepair]}>
                          <Text style={s.chipText}>{m.counts.in_repair} repair</Text>
                        </View>
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
              tintColor={colors.primary}
              colors={[colors.primary]}
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
                  ? {
                      label: '＋ Add Equipment',
                      onPress: () => router.push('/(app)/(equipment)/add'),
                    }
                  : undefined
              }
            />
          }
        />

        {canAdd && !ms.active && (
          <TouchableOpacity
            style={s.fab}
            onPress={() => router.push('/(app)/(equipment)/add')}
          >
            <Text style={s.fabText}>+</Text>
          </TouchableOpacity>
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

        <BatchLabelPrintSheet
          visible={batchLabels !== null}
          items={batchLabels ?? []}
          onClose={() => { setBatchLabels(null); ms.exit(); }}
        />

      </View>
    </>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  searchRow: {
    flexDirection: 'row', gap: 10, padding: spacing.md, paddingBottom: spacing.sm,
  },
  searchBox: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: colors.surface, borderRadius: radii.md,
    borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12,
  },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, height: 42, fontSize: fontSizes.md, color: colors.textPrimary },
  headerAddBtn: {
    width: 44, height: 44, backgroundColor: colors.primary, borderRadius: radii.md,
    alignItems: 'center', justifyContent: 'center',
  },
  headerAddText: { fontSize: 24, color: '#fff', lineHeight: 28 },
  list: { flex: 1 },
  listContent: { padding: spacing.md, paddingBottom: 96 },
  listContentSelecting: { paddingBottom: 180 },
  card: { marginBottom: spacing.sm },
  cardSelected: { borderColor: colors.primary, backgroundColor: colors.primaryBg },
  checkbox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 2,
    borderColor: colors.textDisabled, alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  checkboxOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  checkMark: { color: colors.surface, fontSize: 13, fontWeight: '800', lineHeight: 16 },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: colors.textPrimary, marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  accent: { width: 4, alignSelf: 'stretch', borderRadius: 2, marginRight: 2 },
  info: { flex: 1, gap: 4 },
  name: { fontSize: fontSizes.body, fontWeight: '700', color: colors.textPrimary },
  catRow: { flexDirection: 'row' },
  catBadge: { borderRadius: radii.sm, paddingHorizontal: 8, paddingVertical: 2, maxWidth: '100%' },
  catBadgeText: { fontSize: fontSizes.caption, fontWeight: '700', color: '#fff' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderRadius: radii.sm, paddingHorizontal: 8, paddingVertical: 2 },
  chipAvail: { backgroundColor: '#D1FAE5' },
  chipDeploy: { backgroundColor: '#DBEAFE' },
  chipRepair: { backgroundColor: '#FEF3C7' },
  chipText: { fontSize: fontSizes.caption, fontWeight: '600', color: colors.textPrimary },
  noUnits: { fontSize: fontSizes.caption, color: colors.textMuted, fontStyle: 'italic' },
  chevron: { fontSize: 22, color: colors.textMuted },
  fab: {
    position: 'absolute', bottom: 24, right: 24,
    width: 54, height: 54, borderRadius: 27,
    backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2, shadowRadius: 4, elevation: 5,
  },
  fabText: { fontSize: 28, color: '#fff', lineHeight: 32 },
});
