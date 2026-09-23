import { View, Text, TouchableOpacity, StyleSheet, ScrollView, useWindowDimensions } from 'react-native';
import { Stack, useRouter, type Href } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles } from '@invenpro/ui';
import { useSession } from '../../src/hooks/useSession';
import { usePermission } from '../../src/hooks/usePermission';
import { ROLE_DISPLAY_NAMES } from '../../src/constants/roles';
import { ROLE_DASHBOARDS } from '../../src/dashboard/presets';
import { StatTiles } from '../../src/components/dashboard/StatTiles';
import { WorkList } from '../../src/components/dashboard/WorkList';
import { QuickActionsRow } from '../../src/components/dashboard/QuickActionsRow';

// Station D3: the real hub. Role-keyed dashboard (hardcoded presets — the old
// 21-file user-editable engine was cut, plan decision #3) above the universal
// nav grid: quick-action pills → stat tiles → work lists → tiles. The Phase-2
// row-count card is gone (it only existed to prove the sync skeleton).
interface Tile { label: string; icon: string; href: Href }
const TILES: Tile[] = [
  { label: 'Scan', icon: '⬛', href: '/(app)/scan' },
  { label: 'Check Out / In', icon: '📦', href: '/(app)/checkout' },
  { label: 'Inventory', icon: '📋', href: '/(app)/inventory' },
  { label: 'Locations', icon: '📍', href: '/(app)/locations' },
  { label: 'Equipment', icon: '🛠', href: '/(app)/equipment' },
  { label: 'Manage Types', icon: '🏷', href: '/(app)/manage-types' },
  { label: 'Quick Add', icon: '➕', href: '/(app)/quickadd' },
  // My Team (myteam.tsx) has no requiredPermission gate of its own — crew
  // membership IS the gate (data-driven, EmptyState if you manage nothing) —
  // so it stays in the ungated tile list, like Scan/Checkout/etc.
  { label: 'My Team', icon: '🧰', href: '/(app)/myteam' },
  // Jobs (Station C1) — old app had no dedicated view/visibility permission
  // (only create_jobs/close_jobs, both action-specific gates the list/detail
  // screens apply themselves); it was only reachable via the cut dashboard
  // preset engine or checkout's job picker. Ungated here like My Team/Activity
  // Log — visibility is universal, actions gate inside the screens.
  { label: 'Jobs', icon: '🏗', href: '/(app)/jobs' },
  // Schedule + On-Call (Station C2) — same reasoning as Jobs: the old app
  // gated neither the day board nor the on-call widget behind a dedicated
  // view permission (only the write actions gate: assigning a slot checks
  // manage_schedule server-side, assigning on-call/coverage checks
  // manage_teams). Both screens self-gate their own write affordances
  // (buttons/taps hidden via usePermission), and on-call's settings
  // sub-screen has its own system_settings gate — so both tiles stay
  // ungated here, like Jobs/My Team/Activity Log.
  { label: 'Schedule', icon: '🗓', href: '/(app)/schedule' },
  { label: 'On-Call', icon: '📟', href: '/(app)/oncall' },
  // Messages (Station D1) — ungated like the old app: every signed-in user
  // can chat; the ChatBell in the shared header is the other entry point.
  { label: 'Messages', icon: '💬', href: '/(app)/chat' },
  // Media hub (Station D2) — ungated like the old app: the hub's own filters
  // gate 'everything' on view_all_logs, and shared-pool rows are audience-
  // scoped in the query itself.
  { label: 'Media', icon: '🖼️', href: '/(app)/media' },
  // Logs (Station B4) — a personal, device-local activity view (see
  // app/(app)/logs/index.tsx's header comment for why it's scoped this way).
  // Ungated like My Team: it only ever shows the signed-in user's own rows.
  { label: 'Activity Log', icon: '🧾', href: '/(app)/logs' },
  // Vehicles + Lockers (Station C3) — old app had no dedicated hub tile for
  // either (only reachable via the Wave-D dashboard's StatTiles/WorkList, or
  // embedded in a location's detail page). Same reasoning as Jobs/Schedule:
  // both list screens self-gate visibility via getVisibleUnits (owner + team
  // + explicit unit_access grants, or every unit for managers), so the tiles
  // stay ungated here — just a new entry point, not a new permission.
  { label: 'Vehicles', icon: '🚐', href: '/(app)/vehicles' },
  { label: 'Lockers', icon: '🔒', href: '/(app)/lockers' },
];

// Users/Roles/Teams/Access/Approvals tiles, gated on their own manage_*/view_*
// permission (matching each destination screen's own gate).
interface GatedTile extends Tile { permission: Parameters<typeof usePermission>[0] }
const ADMIN_TILES: GatedTile[] = [
  { label: 'Users', icon: '👤', href: '/(app)/users', permission: 'manage_users' },
  { label: 'Roles', icon: '🛡', href: '/(app)/roles', permission: 'manage_roles_permissions' },
  // Teams gates on view_teams (the screen's own gate, defaults true for every
  // tier) rather than manage_teams — matching teams/index.tsx's own PermissionGate.
  { label: 'Teams', icon: '👥', href: '/(app)/teams', permission: 'view_teams' },
  // Access (unit_access admin surface) and Approvals (decide-queue) — Station
  // B3. Gated on the same permission each screen itself courtesy-gates on.
  { label: 'Access', icon: '🔐', href: '/(app)/access', permission: 'manage_locations' },
  { label: 'Approvals', icon: '✅', href: '/(app)/approvals', permission: 'manage_teams' },
];

export default function Hub() {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  // Desktop/web: percentage tiles get huge on wide windows — switch to a
  // fixed tile width and cap the content column so the hub reads like a
  // dashboard, not a stretched phone screen.
  const { width } = useWindowDimensions();
  const wide = width >= 700;
  const canManageUsers = usePermission('manage_users');
  const canManageRoles = usePermission('manage_roles_permissions');
  const canViewTeams = usePermission('view_teams');
  const canManageLocations = usePermission('manage_locations');
  const canManageTeams = usePermission('manage_teams');
  const adminTiles = ADMIN_TILES.filter(tile => {
    if (tile.permission === 'manage_users') return canManageUsers;
    if (tile.permission === 'manage_roles_permissions') return canManageRoles;
    if (tile.permission === 'manage_locations') return canManageLocations;
    if (tile.permission === 'manage_teams') return canManageTeams;
    return canViewTeams;
  });

  if (!user) return null;
  const dash = ROLE_DASHBOARDS[user.role];

  return (
    <ScrollView style={styles.container} contentContainerStyle={[styles.content, wide && styles.contentWide]}>
      <Stack.Screen options={{ title: 'InventoryPro' }} />
      <Text style={styles.greeting}>Welcome back,</Text>
      <Text style={styles.name}>{user.name}</Text>
      <Text style={styles.role}>{ROLE_DISPLAY_NAMES[user.role] ?? user.role}</Text>

      {dash?.quickActions && <QuickActionsRow />}
      {dash && <StatTiles stats={dash.stats} />}
      {dash?.lists.map(id => <WorkList key={id} list={id} />)}

      <View style={styles.tileGrid}>
        {[...TILES, ...adminTiles].map(tile => (
          <TouchableOpacity
            key={tile.label}
            style={[styles.tile, wide && styles.tileWide]}
            onPress={() => router.push(tile.href)}
          >
            <Text style={styles.tileIcon}>{tile.icon}</Text>
            <Text style={styles.tileLabel}>{tile.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity style={styles.settingsBtn} onPress={() => router.push('/(app)/settings')}>
        <Text style={styles.settingsText}>Settings & sync status →</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: 20 },
  contentWide: { maxWidth: 900, width: '100%', alignSelf: 'center' },
  greeting: { fontSize: 16, color: t.colors.textSecondary },
  name: { fontSize: 28, fontWeight: '700', color: t.colors.brand },
  role: { fontSize: 13, color: t.colors.textSecondary, marginBottom: 24 },
  tileGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginBottom: 20 },
  tile: {
    width: '31%',
    aspectRatio: 1,
    backgroundColor: t.colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  tileWide: { width: 120 },
  tileIcon: { fontSize: 26 },
  tileLabel: { fontSize: 12, fontWeight: '600', color: t.colors.textPrimary, textAlign: 'center' },
  settingsBtn: { paddingVertical: 12 },
  settingsText: { fontSize: 16, color: t.colors.primaryText, fontWeight: '600' },
});
