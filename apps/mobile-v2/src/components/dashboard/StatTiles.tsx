// Station D3: role-dashboard stat tiles. The ids come from the CLOSED
// StatTileId union in src/dashboard/presets.ts; every id must have a def in
// STAT_DEFS below (the Record type enforces it). All requested stats compute
// in ONE useDbQuery so the hook list never varies with the role's layout.
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles } from '@invenpro/ui';
import { useDbQuery } from '@invenpro/core';
import { StatTileId } from '../../dashboard/presets';
import { useSession } from '../../hooks/useSession';
import { UserSession } from '../../auth/permissions';
import { getActiveCheckoutsForUser, getOpenJobs } from '../../repos/jobs';
import { getDeployedUnitsForUser } from '../../repos/equipmentUnits';
import { getVisibleUnits } from '../../repos/access';
import { isVehicleAvailableForCheckout } from '../../repos/vehicles';
import { getUnseenSharedPoolMediaCount } from '../../repos/media';
import { getScheduleBoardForDay } from '../../repos/schedule';
import { localTodayIso } from '../schedule/dayMath';
import { getRepairs } from '../../repos/repairs';
import { getLowStockItems } from '../../repos/items';
import { getAllActiveUsers } from '../../repos/users';

interface StatDef {
  label: string;
  href: Href;
  compute: (user: UserSession) => number;
}

const STAT_DEFS: Record<StatTileId, StatDef> = {
  // Sum of loose-stock checkouts (activity-log derived) + equipment units this
  // user deployed — "how much do I currently have out", same as the old
  // my-checkouts widget. Tapping lands on the checkout hub's check-IN side.
  'my-checkouts': {
    label: 'My Checkouts',
    href: '/(app)/checkout',
    compute: u => getActiveCheckoutsForUser(u.id).length + getDeployedUnitsForUser(u.id).length,
  },
  // Only vehicles this user can SEE (owner/team/unit_access — getVisibleUnits
  // applies the same scoping as the vehicles list screen), narrowed to ones
  // free to take right now.
  'vehicles-available': {
    label: 'Vehicles Free',
    href: '/(app)/vehicles',
    compute: u => getVisibleUnits(u, 'Vehicle').units
      .filter(v => isVehicleAvailableForCheckout(v.id, u.id)).length,
  },
  'shared-media': {
    label: 'New Shared Media',
    href: '/(app)/media',
    compute: u => getUnseenSharedPoolMediaCount(u.id),
  },
  // Distinct employees with at least one active slot on today's board.
  'scheduled-today': {
    label: 'Scheduled Today',
    href: '/(app)/schedule',
    compute: () => new Set(getScheduleBoardForDay(localTodayIso()).map(r => r.employee_id)).size,
  },
  'open-jobs': {
    label: 'Open Jobs',
    href: '/(app)/jobs',
    compute: () => getOpenJobs().length,
  },
  'open-repairs': {
    label: 'Open Repairs',
    href: '/(app)/repairs',
    compute: () => getRepairs({ done: false }).length,
  },
  'low-stock': {
    label: 'Low Stock',
    href: '/(app)/inventory',
    compute: () => getLowStockItems().length,
  },
  'team-members': {
    label: 'Active Employees',
    href: '/(app)/users',
    compute: () => getAllActiveUsers().length,
  },
};

// Union of every table any stat reads — one shared subscription list keeps the
// useDbQuery key stable across roles (per-stat lists would churn the
// subscribe closure whenever the layout changes; over-invalidation is cheap,
// these are COUNT-scale reads). app_settings is in the list because the
// shared-media count keys off the per-user "seen" watermark stored there.
const STAT_TABLES = [
  'activity_log', 'equipment_units', 'inventory_items', 'stock_by_location',
  'jobs', 'locations', 'vehicle_checkouts', 'unit_access', 'team_members',
  'schedule_assignments', 'users', 'repairs', 'media', 'app_settings',
];

export function StatTiles({ stats }: { stats: StatTileId[] }) {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();

  const values = useDbQuery(
    () => {
      if (!user) return [];
      return stats.map(id => {
        // A tile must never take down the hub — bad/missing data shows 0.
        try {
          return STAT_DEFS[id].compute(user);
        } catch {
          return 0;
        }
      });
    },
    [user?.id, user?.role, stats.join(',')],
    STAT_TABLES,
  );

  if (!user || stats.length === 0) return null;

  return (
    <View style={styles.row}>
      {stats.map((id, i) => (
        <TouchableOpacity
          key={id}
          style={styles.tile}
          onPress={() => router.push(STAT_DEFS[id].href)}
        >
          <Text style={styles.value}>{values?.[i] ?? '…'}</Text>
          <Text style={styles.label}>{STAT_DEFS[id].label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 },
  tile: {
    flexGrow: 1,
    flexBasis: 96,
    backgroundColor: t.colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.colors.border,
    paddingVertical: 12,
    paddingHorizontal: 10,
    alignItems: 'center',
    gap: 2,
  },
  value: { fontSize: 22, fontWeight: '700', color: t.colors.brand },
  label: { fontSize: 11, fontWeight: '600', color: t.colors.textSecondary, textAlign: 'center' },
});
