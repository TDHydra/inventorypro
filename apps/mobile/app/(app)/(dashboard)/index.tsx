import { ScrollView, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { PermissionGate } from '../../../src/components/PermissionGate';
import { QuickAddBanner } from '../../../src/components/QuickAddBanner';
import { DashboardSearch } from '../../../src/components/DashboardSearch';
import { TooltipHint } from '../../../src/components/TooltipHint';
import { getLowStockItems } from '../../../src/db/queries/items';
import { roleColor } from '../../../src/db/queries/users';
import { useMemo, useState } from 'react';
import { ROLE_DISPLAY_NAMES } from '../../../src/constants/roles';
import { track } from '../../../src/telemetry';
import { colors } from '../../../src/theme';

export default function DashboardScreen() {
  const { user } = useSession();
  const router = useRouter();
  const [reshow, setReshow] = useState<(() => void) | null>(null);
  const all = useMemo(() => getLowStockItems(), []);
  const shown = all.slice(0, 3);

  if (!user) return null;

  return (
    <>
      <Stack.Screen options={{ title: 'InventoryPro', headerShown: true }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Pinned search at the very top: tap to expand, type inline, 📷 opens the scanner. */}
        <DashboardSearch />

        {/* Greeting */}
        <View style={styles.greeting}>
          <View style={styles.greetingText}>
            <Text style={[styles.hi, { color: roleColor(user.role) }]}>Hi, {user.name.split(' ')[0]}</Text>
            <Text style={styles.role}>{ROLE_DISPLAY_NAMES[user.role]}</Text>
          </View>
          <TouchableOpacity onPress={() => reshow?.()} style={styles.questionBtn}>
            <Text style={styles.questionBtnText}>?</Text>
          </TouchableOpacity>
        </View>

        <TooltipHint screenKey="dashboard" onReady={fn => setReshow(() => fn)} />

        {/* Big dismissible Quick Add CTA (roles granted quick_add). */}
        <QuickAddBanner />

        {/* Primary actions — gated so roles without checkout/checkin (e.g. office
            managers, checkout_inventory:false) don't see dead-end tiles. */}
        <PermissionGate permission="checkout_inventory">
          <TouchableOpacity
            style={[styles.tile, styles.tilePrimary]}
            onPress={() => { track('action', 'hub_checkout', { screen: 'hub' }); router.push('/(app)/(checkout)'); }}
          >
            <Text style={styles.tileIcon}>📦</Text>
            <Text style={styles.tileLabelPrimary}>Check Out Item</Text>
            <Text style={styles.tileSubPrimary}>Scan or search for an item</Text>
          </TouchableOpacity>
        </PermissionGate>

        <PermissionGate permission="checkin_inventory">
          <TouchableOpacity style={styles.tile} onPress={() => { track('action', 'hub_checkin', { screen: 'hub' }); router.push('/(app)/(checkin)'); }}>
            <Text style={styles.tileIcon}>↩</Text>
            <Text style={styles.tileLabel}>Check In</Text>
          </TouchableOpacity>
        </PermissionGate>

        <PermissionGate permission="checkout_inventory">
          <TouchableOpacity style={styles.tile} onPress={() => { track('action', 'hub_active_checkouts', { screen: 'hub' }); router.push('/(app)/(jobs)'); }}>
            <Text style={styles.tileIcon}>📋</Text>
            <Text style={styles.tileLabel}>My Active Checkouts</Text>
          </TouchableOpacity>
        </PermissionGate>

        {/* Manager sections */}
        <PermissionGate permission="add_inventory">
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Inventory Management</Text>
            <TouchableOpacity style={styles.tile} onPress={() => router.push('/(app)/(inventory)/add')}>
              <Text style={styles.tileIcon}>+</Text>
              <Text style={styles.tileLabel}>Add Stock to Location</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.tile} onPress={() => router.push('/(app)/(equipment)')}>
              <Text style={styles.tileIcon}>🛠️</Text>
              <Text style={styles.tileLabel}>Manage Equipment Catalog</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.tile} onPress={() => router.push('/(app)/(repairs)')}>
              <Text style={styles.tileIcon}>🔧</Text>
              <Text style={styles.tileLabel}>Repairs</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.tile} onPress={() => router.push('/(app)/(locations)')}>
              <Text style={styles.tileIcon}>⇄</Text>
              <Text style={styles.tileLabel}>Manage Locations</Text>
            </TouchableOpacity>
            <PermissionGate permission="edit_inventory">
              <TouchableOpacity style={styles.tile} onPress={() => router.push('/(app)/(inventory)')}>
                <Text style={styles.tileIcon}>✎</Text>
                <Text style={styles.tileLabel}>Manage Item Catalog</Text>
              </TouchableOpacity>
            </PermissionGate>
          </View>
        </PermissionGate>

        <PermissionGate permission="create_jobs">
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Operations</Text>
            <TouchableOpacity style={styles.tile} onPress={() => router.push('/(app)/(jobs)')}>
              <Text style={styles.tileIcon}>🏗</Text>
              <Text style={styles.tileLabel}>Jobs</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.tile} onPress={() => router.push('/(app)/(teams)')}>
              <Text style={styles.tileIcon}>👥</Text>
              <Text style={styles.tileLabel}>Teams</Text>
            </TouchableOpacity>
            <PermissionGate permission="view_all_logs">
              <TouchableOpacity style={styles.tile} onPress={() => router.push('/(app)/(logs)')}>
                <Text style={styles.tileIcon}>📊</Text>
                <Text style={styles.tileLabel}>Activity Logs</Text>
              </TouchableOpacity>
            </PermissionGate>
          </View>
        </PermissionGate>

        <PermissionGate permission="manage_users">
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Admin</Text>
            <TouchableOpacity style={styles.tile} onPress={() => router.push('/(app)/(admin)/users')}>
              <Text style={styles.tileIcon}>👤</Text>
              <Text style={styles.tileLabel}>Users & Permissions</Text>
            </TouchableOpacity>
            <PermissionGate permission="manage_roles_permissions">
              <TouchableOpacity style={styles.tile} onPress={() => router.push('/(app)/(admin)/roles')}>
                <Text style={styles.tileIcon}>🛡</Text>
                <Text style={styles.tileLabel}>Roles & Permissions</Text>
              </TouchableOpacity>
            </PermissionGate>
            <PermissionGate permission="manage_roles_permissions">
              <TouchableOpacity style={styles.tile} onPress={() => router.push('/(app)/(admin)/settings')}>
                <Text style={styles.tileIcon}>⚙</Text>
                <Text style={styles.tileLabel}>Settings</Text>
              </TouchableOpacity>
            </PermissionGate>
          </View>
        </PermissionGate>

        {/* Low stock alert */}
        {shown.length > 0 && (
          <View style={styles.alert}>
            <Text style={styles.alertTitle}>⚠️ Low Stock</Text>
            {shown.map(item => (
              <TouchableOpacity
                key={item.id}
                onPress={() =>
                  router.push({ pathname: '/(app)/(inventory)/[id]', params: { id: item.id } })
                }
              >
                <Text style={styles.alertItem}>
                  {item.name} — {item.total_stock} {item.unit} remaining
                </Text>
              </TouchableOpacity>
            ))}
            {all.length > 3 && (
              <Text style={styles.alertMore}>+{all.length - 3} more</Text>
            )}
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 10, paddingBottom: 40 },
  greeting: { marginBottom: 8, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  greetingText: { flex: 1 },
  hi: { fontSize: 24, fontWeight: '700', color: colors.brand },
  role: { fontSize: 13, color: colors.textSecondary, textTransform: 'capitalize' },
  questionBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  questionBtnText: { fontSize: 14, fontWeight: '700', color: colors.textSecondary },
  tile: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tilePrimary: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
    paddingVertical: 20,
  },
  tileHalf: { flex: 1 },
  tileIcon: { fontSize: 22, marginBottom: 6 },
  tileLabel: { fontSize: 15, fontWeight: '600', color: colors.textPrimary },
  tileLabelPrimary: { fontSize: 18, fontWeight: '700', color: '#fff', marginBottom: 4 },
  tileSubPrimary: { fontSize: 13, color: colors.primaryBg },
  row: { flexDirection: 'row', gap: 10 },
  section: { gap: 8 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 8,
  },
  alert: {
    backgroundColor: colors.accentBg,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
  },
  alertTitle: { fontSize: 14, fontWeight: '700', color: colors.accent },
  alertItem: { fontSize: 13, color: colors.accent },
  alertMore: { fontSize: 13, color: colors.accent, fontWeight: '600', marginTop: 2 },
});
