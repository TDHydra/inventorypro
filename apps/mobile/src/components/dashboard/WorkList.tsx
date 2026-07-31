import { useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { useSession } from '../../hooks/useSession';
import { useReactiveRows } from '../../hooks/useReactiveRows';
import { PermissionGate } from '../PermissionGate';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import type { Permission } from '../../constants/roles';
import type { WidgetConfig, WorkListSource } from '../../dashboard/widgets';
import { getOpenJobs } from '../../db/queries/jobs';
import { getMyAssignedJobs } from '../../db/queries/jobAssignments';
import { getDeployedUnitsForUser } from '../../db/queries/equipmentUnits';
import { getRepairs } from '../../db/queries/repairs';
import { getUnitsDueForService } from '../../db/queries/maintenance';
import { getLowStockItems } from '../../db/queries/items';
import { getUnitLocations } from '../../db/queries/locations';
import { isVehicleAvailableForCheckout } from '../../db/queries/vehicles';

// WorkList (role dashboards §2): a compact card list — title, up to N rows, and
// a "View all" tap-through — driven by the block's `config.source`. Rows come
// from existing local queries via useReactiveRows so the card updates after a
// sync pull without swapping the array reference on no-op bumps.

const DEFAULT_LIMIT = 5;

// Normalized row every source maps into. `updated_at` (when the source has it)
// feeds useReactiveRows' change detection — but it's NOT sufficient alone:
// several sources render values that change without bumping the source row's
// updated_at (low-stock's total_stock lives in stock_by_location, a job rename
// doesn't touch equipment_units, units-due-service has no updated_at at all).
// WorkListCard therefore folds the rendered text into the signal (see `read`).
export interface WorkRow {
  id: string;
  primary: string;
  secondary?: string | null;
  updated_at?: string | null;
}

interface WorkListDef {
  title: string;
  icon: string;
  emptyTitle: string;
  viewAllRoute: string;
  requiredPermission?: Permission;
  read: (userId: string) => WorkRow[];
  // When present, each row is tappable and navigates to rowRoute(row.id)
  // (e.g. my-jobs → the job detail screen). Absent = plain rows, as before.
  rowRoute?: (id: string) => string;
}

// Existing local queries only. Permission per source mirrors the tile/screen it
// taps through to (undefined = data-driven access, like the my-checkouts tile).
const WORK_LIST_DEFS: Record<WorkListSource, WorkListDef> = {
  'my-equipment': {
    title: 'My Equipment', icon: '🛠️', emptyTitle: 'Nothing checked out',
    viewAllRoute: '/(app)/(jobs)',
    read: uid => getDeployedUnitsForUser(uid).map(u => ({
      id: u.id,
      primary: `${u.item_name} · ${u.asset_tag}`,
      secondary: u.job_name ? `On job: ${u.job_name}` : null,
      updated_at: u.updated_at ?? null,
    })),
  },
  // Jobs assigned to me (#160): directly, or via a crew I belong to (resolved
  // at read time from team_members.subteam_id). No requiredPermission — a crew
  // tech without create_jobs is exactly who this list is for; the job detail
  // screen renders read-only without the edit permissions.
  'my-jobs': {
    title: 'My Jobs', icon: '🏗', emptyTitle: 'No jobs assigned to you',
    viewAllRoute: '/(app)/(jobs)',
    rowRoute: id => `/(app)/(jobs)/${id}`,
    read: uid => getMyAssignedJobs(uid).map(j => ({
      id: j.id,
      primary: j.job_number ? `#${j.job_number} · ${j.name}` : j.name,
      secondary: j.customer_name ?? j.type ?? null,
      updated_at: j.updated_at,
    })),
  },
  'open-jobs': {
    title: 'Open Jobs', icon: '🏗', emptyTitle: 'No open jobs',
    viewAllRoute: '/(app)/(jobs)', requiredPermission: 'create_jobs',
    read: () => getOpenJobs().map(j => ({
      id: j.id,
      primary: j.name,
      secondary: j.customer_name ?? j.type ?? null,
      updated_at: j.updated_at,
    })),
  },
  'open-repairs': {
    title: 'Open Repairs', icon: '🔧', emptyTitle: 'No open repairs',
    viewAllRoute: '/(app)/(repairs)', requiredPermission: 'add_inventory',
    read: () => getRepairs({ done: false }).map(r => ({
      id: r.id,
      primary: r.entity_label ?? r.entity_type,
      secondary: r.status,
      updated_at: r.updated_at,
    })),
  },
  'units-due-service': {
    title: 'Due for Service', icon: '⏰', emptyTitle: 'Nothing due for service',
    viewAllRoute: '/(app)/(equipment)', requiredPermission: 'add_inventory',
    read: () => getUnitsDueForService(new Date().toISOString()).map(u => ({
      id: u.id,
      primary: u.asset_tag,
      secondary: `Service due ${new Date(u.next_service_at).toLocaleDateString()}`,
    })),
  },
  'low-stock': {
    title: 'Low Stock', icon: '⚠️', emptyTitle: 'No low-stock items',
    viewAllRoute: '/(app)/(inventory)/low-stock', requiredPermission: 'edit_inventory',
    read: () => getLowStockItems().map(i => ({
      id: i.id,
      primary: i.name,
      secondary: `${i.total_stock} ${i.unit} remaining`,
      updated_at: i.updated_at ?? null,
    })),
  },
  // #177: every vehicle with its live availability (same helper as the Vehicles
  // screen's "Available" segment). No requiredPermission — vehicle state is
  // crew-level, like the vehicles tile itself.
  vehicles: {
    title: 'Vehicles', icon: '🚐', emptyTitle: 'No vehicles yet',
    viewAllRoute: '/(app)/(vehicles)',
    rowRoute: id => `/(app)/(vehicles)/${id}`,
    read: uid => getUnitLocations('Vehicle').map(l => ({
      id: l.id,
      primary: l.name,
      secondary: isVehicleAvailableForCheckout(l.id, uid || null) ? 'Available' : 'Checked out',
      updated_at: l.updated_at,
    })),
  },
};

function isWorkListSource(s: unknown): s is WorkListSource {
  return typeof s === 'string' && Object.prototype.hasOwnProperty.call(WORK_LIST_DEFS, s);
}

function WorkListCard({ source, config }: { source: WorkListSource; config?: WidgetConfig }) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const def = WORK_LIST_DEFS[source];
  const userId = user?.id ?? '';
  // Stable read for useReactiveRows; a failed read (fresh DB mid-migration)
  // yields an empty list → EmptyState, never a crash. useReactiveRows compares
  // rows by id + updated_at only, so overwrite updated_at with a signature that
  // also covers the rendered text — otherwise content-only changes (stock count
  // dropping 5→3 while still low, a service due date moving, a job rename) keep
  // showing stale rows until membership or the source's updated_at changes.
  // WorkRow.updated_at is never displayed, only compared.
  const read = useCallback(() => {
    try {
      return def.read(userId).map(r => ({
        ...r,
        updated_at: `${r.updated_at ?? ''}|${r.primary}|${r.secondary ?? ''}`,
      }));
    } catch { return []; }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- def is static per source
  }, [source, userId]);
  const [rows] = useReactiveRows(read);

  const limit = typeof config?.limit === 'number' && config.limit > 0 ? config.limit : DEFAULT_LIMIT;
  const shown = rows.slice(0, limit);
  const title = config?.title?.trim() || def.title;

  return (
    <Card>
      <Text style={s.title}>{def.icon} {title}</Text>
      {shown.length === 0 ? (
        <EmptyState icon={def.icon} title={def.emptyTitle} />
      ) : (
        <View style={s.rows}>
          {shown.map(r => def.rowRoute ? (
            <TouchableOpacity key={r.id} style={s.row} onPress={() => router.push(def.rowRoute!(r.id) as never)}>
              <Text style={s.primary} numberOfLines={1}>{r.primary}</Text>
              {r.secondary ? <Text style={s.secondary} numberOfLines={1}>{r.secondary}</Text> : null}
            </TouchableOpacity>
          ) : (
            <View key={r.id} style={s.row}>
              <Text style={s.primary} numberOfLines={1}>{r.primary}</Text>
              {r.secondary ? <Text style={s.secondary} numberOfLines={1}>{r.secondary}</Text> : null}
            </View>
          ))}
        </View>
      )}
      <TouchableOpacity style={s.viewAll} onPress={() => router.push(def.viewAllRoute as never)}>
        <Text style={s.viewAllText}>
          {rows.length > shown.length ? `View all (${rows.length}) ›` : 'View all ›'}
        </Text>
      </TouchableOpacity>
    </Card>
  );
}

interface Props { config?: WidgetConfig }

export function WorkList({ config }: Props) {
  const source = config?.source;
  // Tolerate any persisted config: an unknown/missing source renders an
  // EmptyState prompt instead of crashing (forward compat).
  if (!isWorkListSource(source)) {
    return <EmptyState icon="🗒" title="No list configured" subtitle="Edit this dashboard preset to pick a list source" />;
  }
  const perm = WORK_LIST_DEFS[source].requiredPermission;
  // Keyed by source so a live preset edit that swaps the source remounts the
  // card (useReactiveRows re-reads on mount / data-version bumps only).
  const card = <WorkListCard key={source} source={source} config={config} />;
  return perm ? <PermissionGate permission={perm}>{card}</PermissionGate> : card;
}

const makeStyles = (t: Theme) => StyleSheet.create({
  title: { fontSize: t.typography.fontSizes.body, fontWeight: '700', color: t.colors.textPrimary, marginBottom: t.spacing.sm },
  rows: { gap: t.spacing.sm },
  row: { gap: 2 },
  primary: { fontSize: t.typography.fontSizes.body2, fontWeight: '600', color: t.colors.textPrimary },
  secondary: { fontSize: t.typography.fontSizes.caption, color: t.colors.textSecondary },
  viewAll: { marginTop: t.spacing.sm, alignSelf: 'flex-start' },
  viewAllText: { fontSize: t.typography.fontSizes.body2, fontWeight: '600', color: t.colors.primary },
});
