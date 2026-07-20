import { Fragment, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useSession } from '../../hooks/useSession';
import { useDataVersion } from '../../hooks/useDataVersion';
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

// StatTiles (role dashboards §2): a row of tappable count cards, driven by the
// block's `config.stats` source list. Each source mirrors the permission of the
// tile/screen it taps through to (PermissionGate per card — the block itself is
// ungated so mixed-permission configs degrade per card, not all-or-nothing).
// Counts re-read on every sync pull via the data-version subscription.

interface StatDef {
  label: string;
  icon: string;
  route: string;
  requiredPermission?: Permission;
  count: (userId: string) => number;
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
  },
  'open-repairs': {
    label: 'Open Repairs', icon: '🔧', route: '/(app)/(repairs)',
    requiredPermission: 'add_inventory',
    count: () => getRepairs({ done: false }).length,
  },
  'units-due-service': {
    label: 'Due Service', icon: '⏰', route: '/(app)/(equipment)',
    requiredPermission: 'add_inventory',
    count: () => getUnitsDueForService(new Date().toISOString()).length,
  },
  'low-stock': {
    label: 'Low Stock', icon: '⚠️', route: '/(app)/(inventory)/low-stock',
    requiredPermission: 'edit_inventory',
    count: () => getLowStockItems().length,
  },
  'open-jobs': {
    label: 'Open Jobs', icon: '🏗', route: '/(app)/(jobs)',
    requiredPermission: 'create_jobs',
    count: () => getOpenJobs().length,
  },
  'team-members': {
    label: 'Team Members', icon: '👥', route: '/(app)/(admin)/users',
    requiredPermission: 'manage_users',
    count: () => getAllActiveUsers().length,
  },
};

function isStatSource(s: unknown): s is StatSource {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(STAT_DEFS, s);
}

// One count card. Reads its own count keyed on the data-version so it updates
// live after a sync pull; a failed read (fresh DB mid-migration) renders 0
// rather than crashing the dashboard.
function StatTileCard({ source }: { source: StatSource }) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const dataVersion = useDataVersion();
  const def = STAT_DEFS[source];
  const userId = user?.id ?? '';
  const count = useMemo(() => {
    try { return def.count(userId); } catch { return 0; }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- def is static per source
  }, [source, userId, dataVersion]);

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
