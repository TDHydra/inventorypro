import { useState, useCallback, useMemo, useEffect } from 'react';
import {
  View, FlatList, StyleSheet, TouchableOpacity, Text, ActivityIndicator,
  RefreshControl,
} from 'react-native';
import type { Theme } from '../../../src/themes/types';
import { useTheme } from '../../../src/hooks/useTheme';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import { Stack, useRouter } from 'expo-router';
import { ItemCard } from '../../../src/components/ItemCard';
import { QuickAddBanner } from '../../../src/components/QuickAddBanner';
import { searchItems, updateItemFields, getDistinctValues, deleteItems } from '../../../src/db/queries/items';
import { getItemTypes, getItemTypeColorMap } from '../../../src/db/queries/taxonomy';
import { appendOutbox } from '../../../src/sync/outbox';
import { appendLog } from '../../../src/db/queries/log';
import { PermissionGate } from '../../../src/components/PermissionGate';
import { FilterChip } from '../../../src/components/ui/FilterChip';
import { SearchHeader } from '../../../src/components/ui/SearchHeader';
import { confirmSheet } from '../../../src/components/ui/ConfirmSheet';
import { TooltipHint } from '../../../src/components/TooltipHint';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../../src/db/maintenance';
import { useMultiSelect } from '../../../src/hooks/useMultiSelect';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import { useTableVersion } from '../../../src/hooks/useDataVersion';
import { BulkActionBar, BulkAction } from '../../../src/components/BulkActionBar';
import { SearchablePicker, PickerOption } from '../../../src/components/SearchablePicker';
import { ModalSheet } from '../../../src/components/ui/ModalSheet';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FieldLabel } from '../../../src/components/ui/FieldLabel';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import { syncNow } from '../../../src/sync/engine';
import { LabelItem } from '../../../src/labels/printLabel';
import { BatchLabelPrintSheet } from '../../../src/components/BatchLabelPrintSheet';
import { Alert } from '../../../src/lib/themedAlert';
import { Fab } from '../../../src/components/ui/Fab';

interface Item {
  id: string;
  name: string;
  barcode: string | null;
  unit: string;
  unit_category: string;
  total_stock: number;
}

const PAGE_SIZE = 20;

// Tables whose synced rows this list actually renders: item catalog rows, their
// per-location stock totals, and the item-type chips (taxonomy). A background
// pull that only touched an unrelated table (e.g. chat messages) won't bump
// these, so the list skips a needless re-query (#64). Module-level = stable ref.
const INVENTORY_TABLES = ['inventory_items', 'stock_by_location', 'taxonomy_types'];

// Filter value 'all' = no filter; any other value is an Item Type id (#74 P2)
// matched against inventory_items.category_id so renamed types still filter.
const ALL_FILTER = 'all';

export default function InventoryScreen() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const router = useRouter();
  const { user } = useSession();
  const canEdit = usePermission('edit_inventory');
  const canDelete = usePermission('delete_inventory');
  const { locked } = useMaintenanceMode();
  const ms = useMultiSelect<Item>();
  const refreshKey = useFocusOrDataRefresh();
  const dataVersion = useTableVersion(INVENTORY_TABLES);
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [supplierPickerOpen, setSupplierPickerOpen] = useState(false);
  const [minQtyOpen, setMinQtyOpen] = useState(false);
  const [batchLabels, setBatchLabels] = useState<LabelItem[] | null>(null);
  const [minQtyValue, setMinQtyValue] = useState('');
  // Chips: "All" + one per Item Type (value = type id, matched against the item's
  // `category_id`). Falls back to just "All" until item types have synced.
  const filterChips = useMemo(
    () => [
      { id: ALL_FILTER, label: 'All' },
      ...getItemTypes().map(t => ({ id: t.id, label: t.icon ? `${t.icon} ${t.label}` : t.label })),
    ],
    [refreshKey],
  );
  // Item-type label → admin color override; re-read on focus so synced overrides show.
  const typeColorMap = useMemo(() => getItemTypeColorMap(), [refreshKey]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<string>(ALL_FILTER);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const runSearch = useCallback((q: string, cat: string, newOffset: number, append = false) => {
    setLoading(true);
    const typeFilter = cat === ALL_FILTER ? undefined : cat;
    // kind='product' + item-type filtered IN-SQL so pagination (LIMIT/OFFSET +
    // hasMore) is correct. typeFilter is the item_category id → i.category_id.
    const rows = searchItems(q, PAGE_SIZE, newOffset, undefined, 'product', undefined, typeFilter) as Item[];
    if (append) {
      setItems(prev => [...prev, ...rows]);
    } else {
      setItems(rows);
    }
    setHasMore(rows.length === PAGE_SIZE);
    setOffset(newOffset + rows.length);
    setLoading(false);
  }, []);

  // Re-run the current search whenever a background sync pull applies changes
  // (dataVersion bumps), so an already-open list refreshes without the user
  // pulling to refresh. Deliberately keyed only on dataVersion — query/filter
  // changes are already handled by handleSearch/handleFilter below.
  useEffect(() => {
    // Reload the CURRENTLY-loaded window (not just page 1) so a background sync
    // — which now bumps this list only when an inventory-relevant table changed
    // (#64) — doesn't truncate an infinite-scrolled list back to the first page.
    // Re-query 0..current-extent in one shot; fall back to one page on first load.
    const limit = Math.max(PAGE_SIZE, offset);
    const typeFilter = filter === ALL_FILTER ? undefined : filter;
    const rows = searchItems(query, limit, 0, undefined, 'product', undefined, typeFilter) as Item[];
    setItems(rows);
    setHasMore(rows.length === limit);
    setOffset(rows.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataVersion]);

  const handleSearch = (text: string) => {
    setQuery(text);
    runSearch(text, filter, 0);
  };

  const handleFilter = (cat: string) => {
    setFilter(cat);
    runSearch(query, cat, 0);
  };

  const loadMore = () => {
    if (loading || !hasMore) return;
    runSearch(query, filter, offset, true);
  };

  const handleCheckout = (itemId: string) => {
    router.push({ pathname: '/(app)/(checkout)', params: { itemId } });
  };

  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    try { await syncNow(); } catch { /* offline — local reload still runs */ }
    runSearch(query, filter, 0);
    setRefreshing(false);
  }, [refreshing, runSearch, query, filter]);

  // ── Bulk multi-select (gated on edit_inventory, matching the detail edit) ──
  const reloadList = useCallback(() => runSearch(query, filter, 0), [runSearch, query, filter]);

  // Item-type options for the bulk "Set item type" backfill (so existing items
  // get a real type and become filterable). Falls back to any free-typed value.
  const itemTypeOptions = useMemo<PickerOption[]>(
    () => getItemTypes().map(t => ({ id: t.label, label: t.icon ? `${t.icon} ${t.label}` : t.label })),
    [refreshKey],
  );
  const supplierOptions = useMemo<PickerOption[]>(
    () => getDistinctValues('supplier').map(v => ({ id: v, label: v })),
    [refreshKey],
  );

  // Mirror the per-item audit trail for batch catalog edits (the single-row edit
  // path uses entity_type 'item') so bulk changes aren't a blind spot.
  const logItem = useCallback((id: string, note: string) => {
    appendLog({
      action: 'item_updated', entity_type: 'item', entity_id: id,
      user_id: user?.id ?? null, note,
      team_id: null, from_location_id: null, to_location_id: null,
      quantity: null, unit: null, job_id: null, metadata: null, device_id: null,
    });
  }, [user?.id]);

  // Each handler mirrors inventory/[id].tsx: updateItemFields then appendOutbox the
  // returned {id,...fields,updated_at}. returnable is untouched here, so no bool fix.
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

  const applyMinQty = useCallback(() => {
    if (isWriteBlocked()) return;
    const n = parseFloat(minQtyValue);
    if (!Number.isFinite(n) || n < 0) return;
    for (const id of Array.from(ms.selected)) {
      const synced = updateItemFields(id, { min_qty_alert: n });
      appendOutbox('UPDATE', 'inventory_items', synced);
      logItem(id, `Low-stock alert → ${n}`);
    }
    setMinQtyOpen(false);
    setMinQtyValue('');
    reloadList();
    ms.exit();
  }, [ms, reloadList, logItem, minQtyValue]);

  // Offline QR-label batch print. Selected ids are always within the currently
  // loaded window (toggle/selectAll only source from `items`), so we resolve
  // titles/codes from memory — no DB round-trip. Printing is read-only, so it's
  // exempt from the maintenance write block.
  const handlePrintLabels = useCallback(() => {
    const byId = new Map(items.map(i => [i.id, i]));
    const labels: LabelItem[] = Array.from(ms.selected)
      .map(id => byId.get(id))
      .filter((i): i is Item => !!i)
      .map(i => ({ title: i.name, code: i.barcode ?? i.id, payload: `INV:item:${i.id}` }));
    if (labels.length === 0) { ms.exit(); return; }
    // Open the chooser (presets + custom designed templates); print happens there.
    setBatchLabels(labels);
  }, [items, ms]);

  // Permanently delete the selected items (+ their stock & tracked units). Gated by
  // delete_inventory (the action is hidden without it); the server re-checks the
  // permission on the sync DELETE. Irreversible — hence the explicit confirm.
  const handleBulkDelete = useCallback(async () => {
    if (isWriteBlocked()) return;
    const ids = Array.from(ms.selected);
    if (ids.length === 0) { ms.exit(); return; }
    const ok = await confirmSheet({
      title: `Delete ${ids.length} item${ids.length === 1 ? '' : 's'}?`,
      message: 'This permanently removes the selected items along with their stock and any tracked units. This cannot be undone.',
      confirmLabel: `Delete ${ids.length}`,
      destructive: true,
    });
    if (!ok) return;
    for (const id of ids) logItem(id, 'Item deleted');
    deleteItems(ids);
    reloadList();
    ms.exit();
    void syncNow().catch(() => { /* offline — deletes flush on next sync */ });
  }, [ms, reloadList, logItem]);

  const bulkActions = useMemo<BulkAction[]>(() => [
    { key: 'print', label: 'Print labels', onPress: () => { void handlePrintLabels(); } },
    { key: 'category', label: 'Set item type', onPress: () => setCategoryPickerOpen(true) },
    { key: 'supplier', label: 'Set supplier', onPress: () => setSupplierPickerOpen(true) },
    { key: 'minqty', label: 'Set min-stock alert', onPress: () => { setMinQtyValue(''); setMinQtyOpen(true); } },
    ...(canDelete
      ? [{ key: 'delete', label: 'Delete', destructive: true, onPress: () => { void handleBulkDelete(); } } as BulkAction]
      : []),
  ], [handlePrintLabels, canDelete, handleBulkDelete]);

  return (
    <>
      <Stack.Screen options={{ title: 'Inventory', headerShown: true }} />
      <View style={s.container}>
        <View style={s.searchRow}>
          <View style={s.searchBoxWrap}>
            <SearchHeader
              value={query}
              onChange={handleSearch}
              placeholder="Search items or barcode..."
              debounceMs={150}
            />
          </View>
          <TouchableOpacity
            style={s.scanBtn}
            onPress={() => router.push('/(app)/(inventory)/scan')}
          >
            <Text style={s.scanIcon}>⬛</Text>
          </TouchableOpacity>
          {canEdit && !ms.active && (
            <TouchableOpacity
              style={s.scanBtn}
              onPress={() => ms.enter()}
              accessibilityLabel="Select multiple items"
            >
              <Text style={s.scanIcon}>☑️</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={s.filters}>
          {filterChips.map(chip => (
            <FilterChip
              key={chip.id}
              label={chip.label}
              active={filter === chip.id}
              onPress={() => handleFilter(chip.id)}
            />
          ))}
        </View>

        <TooltipHint screenKey="inventory" />

        <FlatList
          data={items}
          keyExtractor={i => i.id}
          renderItem={({ item }) => {
            const selected = ms.isSelected(item.id);
            return (
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => {
                  if (ms.active) { ms.toggle(item.id); return; }
                  router.push({ pathname: '/(app)/(inventory)/[id]', params: { id: item.id } });
                }}
                onLongPress={() => { if (canEdit && !ms.active) ms.enter(item.id); }}
                delayLongPress={300}
              >
                <View style={[s.rowWrap, ms.active && selected && s.rowSelected]}>
                  {ms.active && (
                    <View style={[s.checkbox, selected && s.checkboxOn]}>
                      {selected && <Text style={s.checkMark}>✓</Text>}
                    </View>
                  )}
                  {/* Only intercept touches DURING selection mode so the row can own
                      toggle taps. In normal mode pointerEvents="auto" keeps ItemCard's
                      own touchables (expand / Check Out / Edit) fully working — entering
                      selection mode is done via the explicit "Select" button (long-press
                      is a bonus that fires on the card's non-touchable regions). */}
                  <View style={s.rowCard} pointerEvents={ms.active ? 'none' : 'auto'}>
                    <ItemCard item={item} onCheckout={handleCheckout} typeColorMap={typeColorMap} />
                  </View>
                </View>
              </TouchableOpacity>
            );
          }}
          style={s.list}
          contentContainerStyle={[s.listContent, ms.active && s.listContentSelecting]}
          ListHeaderComponent={ms.active ? null : <QuickAddBanner style={s.listHeaderBanner} />}
          onEndReached={loadMore}
          onEndReachedThreshold={0.3}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={t.colors.primary}
              colors={[t.colors.primary]}
            />
          }
          ListEmptyComponent={
            loading ? null : (
              <View style={s.empty}>
                <Text style={s.emptyText}>
                  {query ? `No items matching "${query}"` : 'Search or browse items above'}
                </Text>
                <PermissionGate permission="edit_inventory">
                  <TouchableOpacity
                    style={s.addItemBtn}
                    onPress={() => router.push('/(app)/(inventory)/add')}
                  >
                    <Text style={s.addItemText}>+ Add Item to Catalog</Text>
                  </TouchableOpacity>
                </PermissionGate>
              </View>
            )
          }
          ListFooterComponent={
            loading ? <ActivityIndicator style={s.loader} color={t.colors.primary} /> : null
          }
        />

        {!ms.active && (
          <PermissionGate permission="edit_inventory">
            <Fab onPress={() => router.push('/(app)/(inventory)/add')} label="Add" />
          </PermissionGate>
        )}

        {canEdit && ms.active && (
          <BulkActionBar
            count={ms.count}
            actions={bulkActions}
            onSelectAll={() => ms.selectAll(items.map(i => i.id))}
            onCancel={ms.exit}
            disabled={locked}
          />
        )}

        {/* Bulk: set item type (backfill) — pick a managed type or free-type a value */}
        <ModalSheet visible={categoryPickerOpen} onClose={() => setCategoryPickerOpen(false)}>
          <Text style={s.sheetTitle}>Set item type for {ms.count} item{ms.count === 1 ? '' : 's'}</Text>
          <SearchablePicker
            placeholder="Pick an item type…"
            options={itemTypeOptions}
            value={null}
            onSelect={(opt) => applyCategory(opt.id)}
            onCreate={(text) => applyCategory(text)}
          />
        </ModalSheet>

        {/* Bulk: set supplier (free entry allowed) */}
        <ModalSheet visible={supplierPickerOpen} onClose={() => setSupplierPickerOpen(false)}>
          <Text style={s.sheetTitle}>Set supplier for {ms.count} item{ms.count === 1 ? '' : 's'}</Text>
          <SearchablePicker
            placeholder="Search or type a supplier…"
            options={supplierOptions}
            value={null}
            onSelect={(opt) => applySupplier(opt.id)}
            onCreate={(text) => applySupplier(text)}
          />
        </ModalSheet>

        {/* Bulk: set low-stock alert */}
        <ModalSheet visible={minQtyOpen} onClose={() => setMinQtyOpen(false)}>
          <Text style={s.sheetTitle}>Set min-stock alert for {ms.count} item{ms.count === 1 ? '' : 's'}</Text>
          <FieldLabel>Low-stock alert</FieldLabel>
          <AppInput
            value={minQtyValue}
            onChangeText={setMinQtyValue}
            keyboardType="decimal-pad"
            placeholder="0"
            autoFocus
          />
          <PrimaryButton label="Apply" onPress={applyMinQty} style={{ marginTop: 12 }} />
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

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  searchRow: { flexDirection: 'row', gap: 10, padding: 12, paddingBottom: 6 },
  searchBoxWrap: { flex: 1, justifyContent: 'center' },
  searchBox: {
    flex: 1, flexDirection: 'row', alignItems: 'center',
    backgroundColor: t.colors.surface, borderRadius: 10,
    borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: 12,
  },
  searchIcon: { fontSize: 16, marginRight: 8 },
  searchInput: { flex: 1, height: 42, fontSize: 15, color: t.colors.textPrimary },
  scanBtn: {
    width: 44, height: 44, backgroundColor: t.colors.primary, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  scanIcon: { fontSize: 20 },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 8, flexWrap: 'wrap' },
  list: { flex: 1 },
  listContent: { padding: 12, paddingBottom: 80 },
  listHeaderBanner: { marginBottom: 10 },
  listContentSelecting: { paddingBottom: 180 },
  rowWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rowCard: { flex: 1 },
  rowSelected: {
    borderRadius: 12, borderWidth: 1, borderColor: t.colors.primary,
    backgroundColor: t.colors.primaryBg, paddingLeft: 8,
  },
  checkbox: {
    width: 22, height: 22, borderRadius: 6, borderWidth: 2,
    borderColor: t.colors.textDisabled, alignItems: 'center', justifyContent: 'center',
    backgroundColor: t.colors.surface, marginLeft: 4,
  },
  checkboxOn: { backgroundColor: t.colors.primary, borderColor: t.colors.primary },
  checkMark: { color: t.colors.surface, fontSize: 13, fontWeight: '800', lineHeight: 16 },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 12 },
  empty: { alignItems: 'center', marginTop: 60, gap: 16 },
  emptyText: { fontSize: 15, color: t.colors.textMuted, textAlign: 'center' },
  addItemBtn: { backgroundColor: t.colors.primary, borderRadius: 10, paddingHorizontal: 20, paddingVertical: 10 },
  addItemText: { color: t.colors.onPrimary, fontWeight: '700', fontSize: 14 },
  loader: { padding: 20 },
});
