import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '../../src/theme';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

interface SyncProgress {
  table: string;
  step: number;
  total: number;
}

const TABLE_LABELS: Record<string, string> = {
  role_settings: 'roles',
  users: 'team members',
  locations: 'locations',
  inventory_items: 'inventory items',
  stock_by_location: 'stock levels',
  jobs: 'jobs',
  teams: 'teams',
  team_members: 'team assignments',
  media: 'media',
};

export default function FirstLaunchScreen() {
  const router = useRouter();
  const [progress, setProgress] = useState<SyncProgress>({ table: 'Starting...', step: 0, total: 9 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    runFullDownload();
  }, []);

  async function runFullDownload() {
    try {
      const tables = [
        'role_settings', 'users', 'locations', 'inventory_items',
        'stock_by_location', 'jobs', 'teams', 'team_members', 'media',
      ];

      for (let i = 0; i < tables.length; i++) {
        const table = tables[i];
        setProgress({ table, step: i + 1, total: tables.length });

        let page = 0;
        let hasMore = true;

        while (hasMore) {
          const res = await fetch(`${API_BASE}/sync/full?table=${table}&page=${page}&limit=500`);
          if (!res.ok) throw new Error(`Failed to download ${table}: ${res.status}`);

          const data = await res.json() as { rows: unknown[]; hasMore: boolean };
          await applyRows(table, data.rows);
          hasMore = data.hasMore;
          page++;
        }
      }

      router.replace('/(auth)/login');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function applyRows(table: string, rows: unknown[]) {
    // Import queries dynamically to avoid circular deps
    const { upsertItem, upsertStock } = await import('../../src/db/queries/items');
    const { upsertLocation } = await import('../../src/db/queries/locations');
    const { upsertUser } = await import('../../src/db/queries/users');
    const { upsertJob } = await import('../../src/db/queries/jobs');

    const schema = await import('../../src/db/schema');
    const db = schema.getDb();

    for (const row of rows as Record<string, unknown>[]) {
      switch (table) {
        case 'inventory_items': upsertItem(row as any); break;
        case 'stock_by_location': upsertStock(row as any, row.location_id as string, row.quantity as number); break;
        case 'locations': upsertLocation(row as any); break;
        case 'users': upsertUser(row as any); break;
        case 'jobs': upsertJob(row as any); break;
        case 'role_settings':
        case 'teams':
        case 'team_members':
        case 'media': {
          // Generic upsert — name columns explicitly from the row keys so we
          // tolerate column-count/order differences (e.g. server omits synced_at)
          // and sanitize values (JSONB objects / booleans) for op-sqlite.
          const cols = Object.keys(row);
          if (cols.length === 0) break;
          db.executeSync(
            `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
            schema.bindParams(Object.values(row))
          );
          break;
        }
      }
    }
  }

  const pct = Math.round((progress.step / progress.total) * 100);

  return (
    <View style={styles.container}>
      <Text style={styles.appName}>InventoryPro</Text>

      {error ? (
        <>
          <Text style={styles.errorText}>Setup failed</Text>
          <Text style={styles.errorDetail}>{error}</Text>
          <Text style={styles.retry} onPress={runFullDownload}>Tap to retry</Text>
        </>
      ) : (
        <>
          <ActivityIndicator size="large" color={colors.primary} style={styles.spinner} />
          <Text style={styles.heading}>Setting things up...</Text>

          <View style={styles.barOuter}>
            <View style={[styles.barInner, { width: `${pct}%` }]} />
          </View>
          <Text style={styles.pct}>{pct}%</Text>

          <Text style={styles.tableLabel}>
            Downloading {TABLE_LABELS[progress.table] ?? progress.table}{' '}
            ({progress.step} of {progress.total})
          </Text>

          <View style={styles.tipBox}>
            <Text style={styles.tipTitle}>💡 One-time setup</Text>
            <Text style={styles.tipBody}>
              This download only happens once. After this, everything works
              offline — no internet required on the job.
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  appName: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.brand,
    marginBottom: 40,
  },
  spinner: { marginBottom: 24 },
  heading: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.brand,
    marginBottom: 20,
  },
  barOuter: {
    width: '100%',
    height: 8,
    backgroundColor: colors.border,
    borderRadius: 4,
    overflow: 'hidden',
    marginBottom: 8,
  },
  barInner: {
    height: '100%',
    backgroundColor: colors.primary,
    borderRadius: 4,
  },
  pct: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 8,
  },
  tableLabel: {
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: 40,
  },
  tipBox: {
    backgroundColor: colors.primaryBg,
    borderRadius: 12,
    padding: 16,
    width: '100%',
  },
  tipTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.primaryText,
    marginBottom: 6,
  },
  tipBody: {
    fontSize: 13,
    color: colors.textPrimary,
    lineHeight: 19,
  },
  errorText: { fontSize: 18, fontWeight: '600', color: colors.danger, marginBottom: 8 },
  errorDetail: { fontSize: 13, color: '#7F1D1D', marginBottom: 20, textAlign: 'center' },
  retry: { fontSize: 16, color: colors.primaryText, fontWeight: '600' },
});
