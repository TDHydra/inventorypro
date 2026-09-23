/**
 * Repairs list. Ported from apps/mobile/app/(app)/(repairs)/index.tsx (134 ln,
 * Station C4).
 *
 * Import mapping applied (docs/REBUILD-PORTING.md):
 *   '../../../src/db/queries/repairs' (getRepairs) → '../../../src/repos/repairs'
 *   '../../../src/db/queries/taxonomy' → '../../../src/repos/taxonomy'
 *   ui/Card, ui/EmptyState, ui/StatusBadge, ui/Fab, ui/ListScreenShell,
 *   useThemedStyles → '@invenpro/ui' (ListScreenShell's own doc comment
 *   already names "the inventory / jobs (all-tab) / repairs index screens"
 *   as its intended consumers — this is the first screen in mobile-v2 to
 *   actually adopt it).
 *   '../../../src/hooks/useDataVersion' → '@invenpro/core'
 *   '/(app)/(repairs)/[id]' route → '/(app)/repairs/[id]' (plain route,
 *     Station C4)
 *   '/(app)/(quickadd)/repair' FAB route → '/(app)/quickadd/[sheet]'
 *     sheet='repair' (no entity context — this FAB doesn't know a target
 *     ahead of time, same as the old app's chooser-only new.tsx entry).
 * Straight port otherwise (open/done/all filter chips, StatusBadge +
 * overdue badge, relative-age label).
 */
import { useState, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { getRepairs, type Repair } from '../../../src/repos/repairs';
import { getTypeIcon, isTerminalStatus } from '../../../src/repos/taxonomy';
import type { Theme } from '@invenpro/ui';
import {
  useThemedStyles, Card, EmptyState, StatusBadge, Fab, ListScreenShell,
  type ShellFilter,
} from '@invenpro/ui';
import { useDataVersion } from '@invenpro/core';
import { usePermission } from '../../../src/hooks/usePermission';
import { useMaintenanceMode } from '../../../src/hooks/useMaintenanceMode';

type StatusFilter = 'open' | 'done' | 'all';

const FILTERS: ShellFilter[] = [
  { id: 'open', label: 'Open' },
  { id: 'done', label: 'Done' },
  { id: 'all', label: 'All' },
];

// Compact relative age from an ISO timestamp (e.g. "3d", "5h", "just now").
function ageLabel(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

export default function RepairsScreen() {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const [filter, setFilter] = useState<StatusFilter>('open');
  // Same gate as RepairQuickAdd — repair tickets are an editor write.
  const canEdit = usePermission('edit_inventory');
  const { locked } = useMaintenanceMode();
  const [reloadKey, setReloadKey] = useState(0);
  const dataVersion = useDataVersion();

  // Include dataVersion so an already-open list refreshes after a background
  // sync pull applies changes, without a manual pull-to-refresh.
  const repairs = useMemo((): Repair[] => {
    const done = filter === 'all' ? undefined : filter === 'done';
    return getRepairs({ done });
  }, [filter, reloadKey, dataVersion]);

  return (
    <>
      <Stack.Screen options={{ title: 'Repairs', headerShown: true }} />
      <ListScreenShell
        data={repairs}
        filters={FILTERS}
        activeFilterId={filter}
        onFilterChange={id => setFilter(id as StatusFilter)}
        onReload={() => setReloadKey(k => k + 1)}
        renderItem={({ item }) => {
          const icon = getTypeIcon('repair_status', item.status);
          const completed = item.completed_at != null;
          const terminal = completed || isTerminalStatus(item.status);
          const overdue = !!item.due_at && !terminal && new Date(item.due_at).getTime() < Date.now();
          return (
            <TouchableOpacity
              style={s.item}
              onPress={() => router.push({ pathname: '/(app)/repairs/[id]', params: { id: item.id } })}
            >
              <Card variant="list">
                <Text style={s.cardName}>{item.entity_label ?? '(unlabeled)'}</Text>
                <View style={s.cardRow}>
                  <StatusBadge
                    label={`${icon ? `${icon} ` : ''}${item.status}`}
                    tone={terminal ? 'success' : 'primary'}
                  />
                  {overdue && <StatusBadge label="Overdue" tone="danger" />}
                  <Text style={s.cardDate}>{ageLabel(item.created_at)}</Text>
                </View>
              </Card>
            </TouchableOpacity>
          );
        }}
        emptyState={
          <EmptyState
            title="No repairs"
            subtitle={
              filter === 'open' ? 'No open repair tickets.'
                : filter === 'done' ? 'No completed repairs yet.'
                : 'No repair tickets recorded.'
            }
          />
        }
        fab={canEdit && !locked ? (
          <Fab
            onPress={() => router.push({ pathname: '/(app)/quickadd/[sheet]', params: { sheet: 'repair' } })}
            label="New repair"
            accessibilityLabel="New repair"
          />
        ) : undefined}
      />
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  // The shell's listContent has no row gap; this keeps the original gap:8 spacing.
  item: { marginBottom: 8 },
  cardName: { fontSize: 15, fontWeight: '600', color: t.colors.textPrimary, marginBottom: 4 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardDate: { fontSize: 12, color: t.colors.textMuted, marginLeft: 'auto' },
});
