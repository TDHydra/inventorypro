import { Fragment, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useSession } from '../../hooks/useSession';
import { useDbQuery } from '../../hooks/useDbQuery';
import { PermissionGate } from '../PermissionGate';
import { EmptyState } from '../ui/EmptyState';
import type { Permission } from '../../constants/roles';
import type { StatSource, WidgetConfig } from '../../dashboard/widgets';
import { getActiveCheckoutsForUser, getOpenJobs } from '../../db/queries/jobs';
import { getDeployedUnitsForUser } from '../../db/queries/equipmentUnits';
import { getRepairs } from '../../db/queries/repairs';
import { getUnitsDueForService } from '../../db/queries/maintenance';
import { getLowStockItems } from '../../db/queries/items';
import { getAllActiveUsers } from '../../db/queries/users';
import { getUnitLocations } from '../../db/queries/locations';
import { isVehicleAvailableForCheckout } from '../../db/queries/vehicles';
import { getSharedPoolMediaCount } from '../../db/queries/media';
import { getScheduleBoardForDay, getScheduleableEmployees } from '../../db/queries/schedule';
import { localTodayIso } from '../schedule/dayMath';

// StatTiles (role dashboards §2): a row of tappable count cards, driven by the
// block's `config.stats` source list. Each source mirrors the permission of the
// tile/screen it taps through to (PermissionGate per card — the block itself is
// ungated so mixed-permission configs degrade per card, not all-or-nothing).
// Each source declares the tables its count reads (`tables`), so a card only
// re-queries when one of THOSE changes — not on every pull (#63/#64).

interface StatDef {
  label: string;
  icon: string;
  route: string;
  requiredPermission?: Permission;
  count: (userId: string) => number;
  // #225: coverage-style stats render "count/denominator" (e.g. 5/8) instead
  // of a bare count. Read in the same useDbQuery pass as `count`.
  denominator?: (userId: string) => number;
  tables: string[];
}

// Existing local queries only (no new DB reads). Permissions in lockstep with
// the WIDGET_REGISTRY tile each stat routes to (or the quick-action scoping
// for low-stock, which mirrors localAlerts' edit_inventory gate).
const STAT_DEFS: Record<StatSource, StatDef> = {
  'my-checkouts': {
    label: 'My Checkouts', icon: '📋', route: '/(app)/(jobs)',
    requiredPermission: 'checkout_inventory',
    // Active stock checkouts + equipment units currently deployed by me.
    count: uid => getActiveCheckoutsForUser(uid).length + getDeployedUnitsForUser(uid).length,
    tables: ['activity_log', 'inventory_items', 'jobs', 'locations', 'equipment_units'],
  },
  'open-repairs': {
    label: 'Open Repairs', icon: '🔧', route: '/(app)/(repairs)',
    requiredPermission: 'add_inventory',
    count: () => getRepairs({ done: false }).length,
    tables: ['repairs'],
  },
  'units-due-service': {
    label: 'Due Service', icon: '⏰', route: '/(app)/(equipment)',
    requiredPermission: 'add_inventory',
    count: () => getUnitsDueForService(new Date().toISOString()).length,
    tables: ['equipment_units'],
  },
  'low-stock': {
    label: 'Low Stock', icon: '⚠️', route: '/(app)/(inventory)/low-stock',
    requiredPermission: 'edit_inventory',
    count: () => getLowStockItems().length,
    // taxonomy_types: resolveLabels maps category ids inside the read.
    tables: ['inventory_items', 'stock_by_location', 'equipment_units', 'taxonomy_types'],
  },
  'open-jobs': {
    label: 'Open Jobs', icon: '🏗', route: '/(app)/(jobs)',
    requiredPermission: 'create_jobs',
    count: () => getOpenJobs().length,
    // taxonomy_types: job type resolved from type_id inside the read (#74 P2).
    tables: ['jobs', 'taxonomy_types'],
  },
  'team-members': {
    label: 'Team Members', icon: '👥', route: '/(app)/(admin)/users',
    requiredPermission: 'manage_users',
    count: () => getAllActiveUsers().length,
    tables: ['users'],
  },
  // #177: vehicles free to check out right now. No requiredPermission — vehicle
  // state is crew-level (#157/#122 A2: vehicles have no per-object ACL). Per-row
  // isVehicleAvailableForCheckout call is sanctioned for small vehicle lists
  // (wave1 plan Task 8), matching the Vehicles screen's "Available" segment.
  'vehicles-available': {
    label: 'Vehicles Available', icon: '🚐', route: '/(app)/(vehicles)',
    count: uid => getUnitLocations('Vehicle')
      .filter(l => isVehicleAvailableForCheckout(l.id, uid || null)).length,
    tables: ['locations', 'vehicles', 'vehicle_checkouts'],
  },
  // Pool photos other users shared to me. No requiredPermission — mirrors the
  // ungated `media` hub tile; the pull scope SQL already limits local pool
  // rows to what this user may see.
  'shared-media': {
    label: 'Shared Media', icon: '🖼️', route: '/(app)/(media)',
    count: uid => getSharedPoolMediaCount(uid),
    tables: ['media'],
  },
  // #225: today's board coverage at a glance — scheduled/total tier-1 crew.
  // manage_schedule mirrors who acts on a gap (same scoping as the #224
  // schedule-gaps quick-action; crew see their own day via my-schedule-today).
  'scheduled-today': {
    label: 'Scheduled Today', icon: '🗓', route: '/(app)/(schedule)',
    requiredPermission: 'manage_schedule',
    count: () => {
      const covered = new Set(getScheduleBoardForDay(localTodayIso()).map(a => a.employee_id));
      return getScheduleableEmployees().filter(u => covered.has(u.id)).length;
    },
    denominator: () => getScheduleableEmployees().length,
    tables: ['schedule_assignments', 'users'],
  },
};

function isStatSource(s: unknown): s is StatSource {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(STAT_DEFS, s);
}

// One count card. Reads its own count scoped to the source's declared tables so
// it updates live after a relevant pull; a failed read (fresh DB mid-migration)
// renders 0 rather than crashing the dashboard. Cards are keyed by source, so
// `def.tables` is constant for a mounted card — the useDbQuery contract holds.
function StatTileCard({ source }: { source: StatSource }) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const def = STAT_DEFS[source];
  const userId = user?.id ?? '';
  const count = useDbQuery(() => {
    try {
      const n = def.count(userId);
      // #225: coverage stats read as "n/total"; plain stats stay a bare count.
      return def.denominator ? `${n}/${def.denominator(userId)}` : String(n);
    } catch { return '0'; }
  }, [source, userId], def.tables);

  return (
    <TouchableOpacity style={s.card} onPress={() => router.push(def.route as never)}>
      <Text style={s.count}>{count}</Text>
      <Text style={s.label} numberOfLines={2}>{def.icon} {def.label}</Text>
    </TouchableOpacity>
  );
}

interface Props { config?: WidgetConfig }

export function StatTiles({ config }: Props) {
  const s = useThemedStyles(makeStyles);
  // Tolerate any persisted config: unknown/misshapen sources are skipped, and a
  // repeated source renders once (defensive against hand-edited presets).
  const sources = useMemo(() => {
    const raw = Array.isArray(config?.stats) ? config.stats : [];
    return [...new Set(raw.filter(isStatSource))];
  }, [config]);

  if (sources.length === 0) {
    return <EmptyState icon="🔢" title="No stats configured" subtitle="Edit this dashboard preset to pick stat sources" />;
  }

  return (
    <View style={s.row}>
      {sources.map(src => {
        const perm = STAT_DEFS[src].requiredPermission;
        // PermissionGate renders a Fragment, so a gated-out card frees its flex
        // share to the remaining cards instead of leaving a hole.
        return perm ? (
          <PermissionGate key={src} permission={perm}><StatTileCard source={src} /></PermissionGate>
        ) : (
          <Fragment key={src}><StatTileCard source={src} /></Fragment>
        );
      })}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  row: { flexDirection: 'row', gap: t.spacing.sm },
  card: {
    flex: 1,
    backgroundColor: t.colors.surface,
    borderRadius: t.radii.md,
    borderWidth: 1,
    borderColor: t.colors.border,
    padding: t.spacing.md,
    gap: t.spacing.xs,
  },
  count: { fontSize: t.typography.fontSizes.xl, fontWeight: '700', color: t.colors.textPrimary },
  label: { fontSize: t.typography.fontSizes.caption, fontWeight: '600', color: t.colors.textSecondary },
});
