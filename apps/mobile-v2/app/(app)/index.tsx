import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { Stack, useRouter, type Href } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles } from '@invenpro/ui';
import { useDbQuery, TABLES } from '@invenpro/core';
import { useSession } from '../../src/hooks/useSession';
import { usePermission } from '../../src/hooks/usePermission';
import { ROLE_DISPLAY_NAMES } from '../../src/constants/roles';
import { getDb } from '../../src/db/schema';

// Phase 2 hub stub — proves the skeleton end-to-end (session, DB, sync) by
// showing live row counts for a handful of core tables, plus (Wave A) a tile
// grid to the surfaces landing this wave. The REAL hub — old (hub)/index.tsx,
// 1144 lines with role dashboards — is Wave D; do not port it here.
const COUNT_TABLES = ['users', 'locations', 'inventory_items', 'stock_by_location', 'jobs', 'teams'] as const;

// Wave A tiles. The real role-based hub (dashboard tiles) lands in Wave D.
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
  // Logs (Station B4) — a personal, device-local activity view (see
  // app/(app)/logs/index.tsx's header comment for why it's scoped this way).
  // Ungated like My Team: it only ever shows the signed-in user's own rows.
  { label: 'Activity Log', icon: '🧾', href: '/(app)/logs' },
];

// Wave B: Users/Roles/Teams tiles, gated on their own manage_*/view_*
// permission (the only entry point to those screens until the real
// role-based hub lands in Wave D).
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

export default function HubStub() {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
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

  const counts = useDbQuery(
    () => {
      const db = getDb();
      const out: Record<string, number> = {};
      for (const table of COUNT_TABLES) {
        try {
          out[table] = (db.executeSync(`SELECT COUNT(*) AS n FROM ${table}`).rows[0] as { n: number }).n;
        } catch {
          out[table] = -1;
        }
      }
      return out;
    },
    [],
    [...COUNT_TABLES],
  );

  if (!user) return null;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'InventoryPro' }} />
      <Text style={styles.greeting}>Welcome back,</Text>
      <Text style={styles.name}>{user.name}</Text>
      <Text style={styles.role}>{ROLE_DISPLAY_NAMES[user.role] ?? user.role}</Text>

      <View style={styles.tileGrid}>
        {[...TILES, ...adminTiles].map(tile => (
          <TouchableOpacity
            key={tile.label}
            style={styles.tile}
            onPress={() => router.push(tile.href)}
          >
            <Text style={styles.tileIcon}>{tile.icon}</Text>
            <Text style={styles.tileLabel}>{tile.label}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Local data ({TABLES.length} synced tables)</Text>
        {COUNT_TABLES.map(table => (
          <View key={table} style={styles.row}>
            <Text style={styles.rowLabel}>{table.replace(/_/g, ' ')}</Text>
            <Text style={styles.rowValue}>{counts?.[table] ?? '…'}</Text>
          </View>
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
  tileIcon: { fontSize: 26 },
  tileLabel: { fontSize: 12, fontWeight: '600', color: t.colors.textPrimary, textAlign: 'center' },
  card: {
    backgroundColor: t.colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.colors.border,
    padding: 16,
    marginBottom: 20,
  },
  cardTitle: { fontSize: 14, fontWeight: '700', color: t.colors.textPrimary, marginBottom: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  rowLabel: { fontSize: 14, color: t.colors.textSecondary, textTransform: 'capitalize' },
  rowValue: { fontSize: 14, fontWeight: '600', color: t.colors.textPrimary },
  settingsBtn: { paddingVertical: 12 },
  settingsText: { fontSize: 16, color: t.colors.primaryText, fontWeight: '600' },
});
