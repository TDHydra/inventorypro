// Station D3: contextual quick-action pills at the top of the crew hub
// (#144/#149/#168/#224). Pure decision logic lives in
// src/dashboard/quickActions.ts (computeQuickActions — unit-tested); this
// component only gathers the reactive inputs and routes taps.
import { ScrollView, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles } from '@invenpro/ui';
import { useDbQuery } from '@invenpro/core';
import { computeQuickActions, isOverdueRepair, QuickAction } from '../../dashboard/quickActions';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { getActiveCheckoutForUser } from '../../repos/vehicles';
import { getRepairs } from '../../repos/repairs';
import { isTerminalStatus } from '../../repos/taxonomy';
import { getUnitsDueForService } from '../../repos/maintenance';
import { getLowStockItems } from '../../repos/items';
import { getScheduleBoardForDay, getScheduleableEmployees } from '../../repos/schedule';
import { localTodayIso } from '../schedule/dayMath';

const TABLES = [
  'vehicle_checkouts', 'locations', 'repairs', 'taxonomy_types',
  'equipment_units', 'inventory_items', 'stock_by_location',
  'schedule_assignments', 'users',
];

export function QuickActionsRow() {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const canEditInventory = usePermission('edit_inventory');
  const canManageSchedule = usePermission('manage_schedule');

  const actions = useDbQuery(
    () => {
      if (!user) return [] as QuickAction[];
      try {
        // Permission-scoped counts are only computed when they can surface —
        // same scoping computeQuickActions applies, skipping the reads too.
        const scheduledIds = canManageSchedule
          ? new Set(getScheduleBoardForDay(localTodayIso()).map(r => r.employee_id))
          : null;
        return computeQuickActions({
          activeVehicleCheckout: getActiveCheckoutForUser(user.id),
          overdueRepairCount: canEditInventory
            ? getRepairs({ done: false }).filter(r => isOverdueRepair(r, isTerminalStatus, Date.now())).length
            : 0,
          serviceDueCount: canEditInventory ? getUnitsDueForService(new Date().toISOString()).length : 0,
          canEditInventory,
          lowStockCount: canEditInventory ? getLowStockItems().length : 0,
          canManageSchedule,
          unscheduledTodayCount: scheduledIds
            ? getScheduleableEmployees().filter(e => !scheduledIds.has(e.id)).length
            : 0,
        });
      } catch {
        return [] as QuickAction[];
      }
    },
    [user?.id, canEditInventory, canManageSchedule],
    TABLES,
  );

  if (!user || !actions || actions.length === 0) return null;

  const onPress = (a: QuickAction) => {
    switch (a.key) {
      case 'vehicle-checkin':
        if (a.mode === 'check_in') {
          router.push({ pathname: '/(app)/vehicles/[id]', params: { id: a.vehicleLocationId } });
        } else {
          router.push('/(app)/vehicles');
        }
        return;
      case 'gas-receipt':
        // The vehicle panel owns the gas-receipt form; deep param plumbing
        // wasn't ported (old app opened a sheet via nav param — cut with the
        // preset engine; one extra tap on the panel instead).
        router.push({ pathname: '/(app)/vehicles/[id]', params: { id: a.vehicleLocationId } });
        return;
      case 'past-due':
        router.push(a.target === 'repairs' ? '/(app)/repairs' : '/(app)/equipment');
        return;
      case 'low-stock-catalog':
        router.push('/(app)/inventory');
        return;
      case 'schedule-gaps':
        router.push('/(app)/schedule');
        return;
    }
  };

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.strip} contentContainerStyle={styles.stripContent}>
      {actions.map(a => (
        <TouchableOpacity key={`${a.key}:${'mode' in a ? a.mode : ''}`} style={styles.pill} onPress={() => onPress(a)}>
          <Text style={styles.pillText}>{a.label}</Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  strip: { marginBottom: 16, flexGrow: 0 },
  stripContent: { gap: 8 },
  pill: {
    backgroundColor: t.colors.primary,
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  pillText: { fontSize: 13, fontWeight: '700', color: t.colors.onPrimary },
});
