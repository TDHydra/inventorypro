import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles } from '@invenpro/ui';
import { useDbQuery, TABLES } from '@invenpro/core';
import { useSession } from '../../src/hooks/useSession';
import { ROLE_DISPLAY_NAMES } from '../../src/constants/roles';
import { getDb } from '../../src/db/schema';

// Phase 2 hub stub — proves the skeleton end-to-end (session, DB, sync) by
// showing live row counts for a handful of core tables. Wave A replaces this
// with the real hub (scanner, tiles, quick actions).
const COUNT_TABLES = ['users', 'locations', 'inventory_items', 'stock_by_location', 'jobs', 'teams'] as const;

export default function HubStub() {
  const styles = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();

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
