import { ScrollView, View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter, Stack } from 'expo-router';
import { useSession } from '../../../src/hooks/useSession';
import { PermissionGate } from '../../../src/components/PermissionGate';
import { TooltipHint } from '../../../src/components/TooltipHint';
import { getLowStockItems } from '../../../src/db/queries/items';
import { useMemo } from 'react';
import { ROLE_DISPLAY_NAMES } from '../../../src/constants/roles';

export default function DashboardScreen() {
  const { user } = useSession();
  const router = useRouter();
  const lowStock = useMemo(() => getLowStockItems().slice(0, 3), []);

  if (!user) return null;

  return (
    <>
      <Stack.Screen options={{ title: 'InventoryPro', headerShown: true }} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        {/* Greeting */}
        <View style={styles.greeting}>
          <Text style={styles.hi}>Hi, {user.name.split(' ')[0]}</Text>
          <Text style={styles.role}>{ROLE_DISPLAY_NAMES[user.role]}</Text>
        </View>

        <TooltipHint screenKey="dashboard" />

        {/* Primary actions */}
        <TouchableOpacity
          style={[styles.tile, styles.tilePrimary]}
          onPress={() => router.push('/(app)/(checkout)')}
        >
          <Text style={styles.tileIcon}>📦</Text>
          <Text style={styles.tileLabelPrimary}>Check Out Item</Text>
          <Text style={styles.tileSubPrimary}>Scan or search for an item</Text>
        </TouchableOpacity>

        <View style={styles.row}>
          <TouchableOpacity style={[styles.tile, styles.tileHalf]} onPress={() => router.push('/(app)/(checkin)')}>
            <Text style={styles.tileIcon}>↩</Text>
            <Text style={styles.tileLabel}>Check In</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.tile, styles.tileHalf]} onPress={() => router.push('/(app)/(inventory)')}>
            <Text style={styles.tileIcon}>🔍</Text>
            <Text style={styles.tileLabel}>Browse</Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity style={styles.tile} onPress={() => router.push('/(app)/(jobs)')}>
          <Text style={styles.tileIcon}>📋</Text>
          <Text style={styles.tileLabel}>My Active Checkouts</Text>
        </TouchableOpacity>

        {/* Manager sections */}
        <PermissionGate permission="add_inventory">
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Inventory Management</Text>
            <TouchableOpacity style={styles.tile} onPress={() => router.push('/(app)/(inventory)/add')}>
              <Text style={styles.tileIcon}>+</Text>
              <Text style={styles.tileLabel}>Add Stock to Location</Text>
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
        {lowStock.length > 0 && (
          <View style={styles.alert}>
            <Text style={styles.alertTitle}>⚠️ Low Stock</Text>
            {lowStock.map(item => (
              <Text key={item.id} style={styles.alertItem}>
                {item.name} — {item.total_stock} {item.unit} remaining
              </Text>
            ))}
          </View>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF' },
  content: { padding: 16, gap: 10, paddingBottom: 40 },
  greeting: { marginBottom: 8 },
  hi: { fontSize: 24, fontWeight: '700', color: '#1E3A5F' },
  role: { fontSize: 13, color: '#64748B', textTransform: 'capitalize' },
  tile: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: '#E2E8F0',
  },
  tilePrimary: {
    backgroundColor: '#2563EB',
    borderColor: '#2563EB',
    paddingVertical: 20,
  },
  tileHalf: { flex: 1 },
  tileIcon: { fontSize: 22, marginBottom: 6 },
  tileLabel: { fontSize: 15, fontWeight: '600', color: '#1E293B' },
  tileLabelPrimary: { fontSize: 18, fontWeight: '700', color: '#fff', marginBottom: 4 },
  tileSubPrimary: { fontSize: 13, color: '#BFDBFE' },
  row: { flexDirection: 'row', gap: 10 },
  section: { gap: 8 },
  sectionTitle: { fontSize: 12, fontWeight: '700', color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 1, marginTop: 8 },
  alert: {
    backgroundColor: '#FFF7ED',
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: '#FED7AA',
    gap: 4,
  },
  alertTitle: { fontSize: 14, fontWeight: '700', color: '#C2410C' },
  alertItem: { fontSize: 13, color: '#9A3412' },
});
