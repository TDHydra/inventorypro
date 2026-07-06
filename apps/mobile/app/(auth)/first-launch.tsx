import { useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { colors } from '../../src/theme';
import { useSession } from '../../src/hooks/useSession';
import { getValidJwt, getSavedUserId, clearSession } from '../../src/auth/session';
import { finishLogin } from '../../src/auth/finishLogin';
import {
  runFullDownload, SessionExpiredError, FULL_DOWNLOAD_TABLE_COUNT,
  type DownloadProgress,
} from '../../src/sync/fullDownload';

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

// Post-login enrollment download. We arrive here ONLY after a successful PIN
// sign-in on a brand-new device, so the session/JWT is already saved and
// /sync/full can be called authenticated. When the download finishes we build
// the session locally and enter the app.
export default function FirstLaunchScreen() {
  const router = useRouter();
  const { setUser } = useSession();
  const [progress, setProgress] = useState<DownloadProgress>({
    table: 'Starting...', step: 0, total: FULL_DOWNLOAD_TABLE_COUNT,
  });
  const [error, setError] = useState<string | null>(null);

  const runDownload = useCallback(async () => {
    setError(null);
    try {
      const userId = await getSavedUserId();
      const jwt = await getValidJwt();
      if (!userId || !jwt) {
        // No session — shouldn't happen via the login flow; recover gracefully.
        await clearSession();
        router.replace('/(auth)/login');
        return;
      }

      await runFullDownload(jwt, setProgress);

      if (!finishLogin(userId, setUser)) {
        setError('Setup finished, but your account was not found. Please sign in again.');
        return;
      }
      router.replace('/(app)/(dashboard)');
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        await clearSession();
        router.replace('/(auth)/login');
        return;
      }
      setError((err as Error).message);
    }
  }, [router, setUser]);

  useEffect(() => { runDownload(); }, [runDownload]);

  const pct = progress.total ? Math.round((progress.step / progress.total) * 100) : 0;

  return (
    <View style={styles.container}>
      <Text style={styles.appName}>InventoryPro</Text>

      {error ? (
        <>
          <Text style={styles.errorText}>Setup failed</Text>
          <Text style={styles.errorDetail}>{error}</Text>
          <TouchableOpacity onPress={runDownload}>
            <Text style={styles.retry}>Tap to retry</Text>
          </TouchableOpacity>
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
