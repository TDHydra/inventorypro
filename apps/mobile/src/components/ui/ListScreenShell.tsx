import React, { useState, useCallback } from 'react';
import { View, FlatList, ListRenderItem, RefreshControl, StyleSheet } from 'react-native';
import { FilterChip } from './FilterChip';
import { BulkActionBar, BulkAction } from '../BulkActionBar';
import { MultiSelect } from '../../hooks/useMultiSelect';
import { syncNow } from '../../sync/engine';
import { colors } from '../../theme';

export interface ShellFilter {
  id: string;
  label: string;
}

export interface ListScreenShellProps<T extends { id: string }> {
  data: readonly T[];
  renderItem: ListRenderItem<T>;
  keyExtractor?: (item: T, index: number) => string;
  /** Search box / scan buttons — the shell doesn't own search state. */
  searchRow?: React.ReactNode;
  filters?: ShellFilter[];
  activeFilterId?: string;
  onFilterChange?: (id: string) => void;
  /** Rendered between the chip row and the FlatList (e.g. TooltipHint). */
  aboveList?: React.ReactNode;
  listHeader?: React.ReactNode;
  listFooter?: React.ReactNode;
  emptyState: React.ReactNode;
  onEndReached?: () => void;
  /** Re-query local data after a pull-to-refresh; the shell owns `refreshing`. */
  onReload: () => void | Promise<void>;
  /** Pull-to-refresh runs syncNow() before onReload. Default true. */
  syncOnRefresh?: boolean;
  /** When ms.active the shell swaps the fab slot for a BulkActionBar. */
  bulk?: {
    ms: MultiSelect;
    actions: BulkAction[];
    selectAllIds?: string[];
    disabled?: boolean;
  };
  fab?: React.ReactNode;
}

/**
 * The `search row + FilterChip row + FlatList + RefreshControl(sync) +
 * BulkActionBar/FAB` shape shared by the inventory / jobs (all-tab) / repairs
 * index screens. Pure composition — no DB access, no data-version hooks; the
 * screen keeps its own query state and passes `onReload`. Teams index is a
 * sectioned ScrollView and is deliberately NOT a consumer.
 */
export function ListScreenShell<T extends { id: string }>({
  data,
  renderItem,
  keyExtractor,
  searchRow,
  filters,
  activeFilterId,
  onFilterChange,
  aboveList,
  listHeader,
  listFooter,
  emptyState,
  onEndReached,
  onReload,
  syncOnRefresh = true,
  bulk,
  fab,
}: ListScreenShellProps<T>) {
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    if (syncOnRefresh) {
      try { await syncNow(); } catch { /* offline — local reload still runs */ }
    }
    await onReload();
    setRefreshing(false);
  }, [refreshing, syncOnRefresh, onReload]);

  const selecting = bulk?.ms.active ?? false;

  return (
    <View style={s.container}>
      {searchRow}

      {filters && filters.length > 0 && (
        <View style={s.filters}>
          {filters.map(f => (
            <FilterChip
              key={f.id}
              label={f.label}
              active={f.id === activeFilterId}
              onPress={() => onFilterChange?.(f.id)}
            />
          ))}
        </View>
      )}

      {aboveList}

      <FlatList
        data={data as T[]}
        keyExtractor={keyExtractor ?? (i => i.id)}
        renderItem={renderItem}
        style={s.list}
        contentContainerStyle={[s.listContent, selecting && s.listContentSelecting]}
        ListHeaderComponent={listHeader == null ? null : <>{listHeader}</>}
        ListFooterComponent={listFooter == null ? null : <>{listFooter}</>}
        ListEmptyComponent={<>{emptyState}</>}
        onEndReached={onEndReached}
        onEndReachedThreshold={0.3}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
      />

      {bulk && bulk.ms.active ? (
        <BulkActionBar
          count={bulk.ms.count}
          actions={bulk.actions}
          onSelectAll={bulk.selectAllIds && (() => bulk.ms.selectAll(bulk.selectAllIds!))}
          onCancel={bulk.ms.exit}
          disabled={bulk.disabled}
        />
      ) : (
        fab
      )}
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 8, flexWrap: 'wrap' },
  list: { flex: 1 },
  // Copied verbatim from (inventory)/index.tsx listContent / listContentSelecting
  // so a converted screen is pixel-identical (the bump keeps the last row above
  // the BulkActionBar).
  listContent: { padding: 12, paddingBottom: 80 },
  listContentSelecting: { paddingBottom: 180 },
});
