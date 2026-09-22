import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useTheme, useThemedStyles, themeList } from '@invenpro/ui';
import { useDbQuery, getOutboxCounts, getDeniedOutbox, getAppSetting, syncNow, getConnectivity } from '@invenpro/core';
import { useSession } from '../../src/hooks/useSession';
import { chooseTheme } from '../../src/db/userPrefs';

// Phase 2 settings stub: sync status + theme picker (the theme write is the
// skeleton's outbox round-trip probe — pick a theme, watch it push). The full
// settings hub (org/sync/security/notifications/fields/access-defaults)
// arrives in Wave D.
export default function SettingsStub() {
  const styles = useThemedStyles(makeStyles);
  const t = useTheme();
  const { realUser } = useSession();
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

  const status = useDbQuery(
    () => ({
      counts: getOutboxCounts(),
      denied: getDeniedOutbox().length,
      lastPulledAt: getAppSetting('last_pulled_at'),
    }),
    [],
    ['outbox', 'app_settings'],
  );

  async function handleSyncNow() {
    setSyncing(true);
    setSyncResult(null);
    try {
      await syncNow();
      setSyncResult('Synced.');
    } catch (err) {
      setSyncResult(`Sync failed: ${(err as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Settings' }} />

      <Text style={styles.sectionTitle}>Sync</Text>
      <View style={styles.card}>
        <Row label="Connectivity" value={getConnectivity() ? 'online' : 'offline'} styles={styles} />
        <Row label="Pending changes" value={String(status?.counts.active ?? '…')} styles={styles} />
        <Row label="Failed" value={String(status?.counts.failed ?? '…')} styles={styles} />
        <Row label="Denied" value={String(status?.denied ?? '…')} styles={styles} />
        <Row label="Last pull" value={status?.lastPulledAt ?? 'never'} styles={styles} />
        <TouchableOpacity style={styles.syncBtn} onPress={handleSyncNow} disabled={syncing}>
          <Text style={styles.syncBtnText}>{syncing ? 'Syncing…' : 'Sync now'}</Text>
        </TouchableOpacity>
        {syncResult && <Text style={styles.syncResult}>{syncResult}</Text>}
      </View>

      <Text style={styles.sectionTitle}>Theme</Text>
      <View style={styles.card}>
        {themeList().map(option => (
          <TouchableOpacity
            key={option.id}
            style={styles.themeRow}
            onPress={() => realUser && chooseTheme(realUser.id, option.id)}
          >
            <View style={[styles.swatch, { backgroundColor: option.colors.primary }]} />
            <Text style={styles.themeName}>{option.name}</Text>
            {option.id === t.id && <Text style={styles.check}>✓</Text>}
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

function Row({ label, value, styles }: { label: string; value: string; styles: ReturnType<typeof makeStyles> }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: 20 },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: t.colors.textSecondary, textTransform: 'uppercase', marginBottom: 8, marginTop: 12 },
  card: {
    backgroundColor: t.colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: t.colors.border,
    padding: 16,
    marginBottom: 12,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 },
  rowLabel: { fontSize: 14, color: t.colors.textSecondary },
  rowValue: { fontSize: 14, fontWeight: '600', color: t.colors.textPrimary },
  syncBtn: {
    marginTop: 12,
    backgroundColor: t.colors.primary,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  syncBtnText: { color: t.colors.onPrimary, fontSize: 15, fontWeight: '700' },
  syncResult: { marginTop: 8, fontSize: 13, color: t.colors.textSecondary, textAlign: 'center' },
  themeRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10 },
  swatch: { width: 22, height: 22, borderRadius: 6, marginRight: 12, borderWidth: 1, borderColor: t.colors.border },
  themeName: { flex: 1, fontSize: 15, color: t.colors.textPrimary },
  check: { fontSize: 16, color: t.colors.primaryText, fontWeight: '700' },
});
