import { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles } from '@invenpro/ui';
import {
  useDbQuery, getOutboxCounts, getDeniedOutbox, getAppSetting, syncNow, getConnectivity,
} from '@invenpro/core';

// Station D3: Settings → Sync & Data. The Phase 2 stub's sync-status card,
// moved here in the settings split (the stub's theme picker went to the hub).
// All users — sync health is everyone's problem when a truck is out of signal.

export default function SyncSettings() {
  const s = useThemedStyles(makeStyles);
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
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <Stack.Screen options={{ title: 'Sync & Data' }} />

      <View>
        <Text style={s.sectionTitle}>Status</Text>
        <View style={s.card}>
          <Row label="Connectivity" value={getConnectivity() ? 'Online' : 'Offline'} s={s} />
          <View style={s.divider} />
          <Row label="Pending changes" value={String(status?.counts.active ?? '…')} s={s} />
          <View style={s.divider} />
          <Row label="Failed (will retry)" value={String(status?.counts.failed ?? '…')} s={s} />
          <View style={s.divider} />
          <Row label="Denied by server" value={String(status?.denied ?? '…')} s={s} />
          <View style={s.divider} />
          <Row label="Last pull" value={status?.lastPulledAt ?? 'never'} s={s} />
        </View>
      </View>

      <View>
        <View style={s.card}>
          <TouchableOpacity style={s.syncBtn} onPress={handleSyncNow} disabled={syncing}>
            <Text style={s.syncBtnText}>{syncing ? 'Syncing…' : 'Sync now'}</Text>
          </TouchableOpacity>
          {syncResult && <Text style={s.syncResult}>{syncResult}</Text>}
          <View style={s.infoBlock}>
            <Text style={s.rowSub}>
              Changes save on this device instantly and upload in the background.
              Pending items push automatically whenever you&apos;re online — this
              button just forces a round-trip right now.
            </Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

function Row({ label, value, s }: { label: string; value: string; s: ReturnType<typeof makeStyles> }) {
  return (
    <View style={s.row}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={s.rowValue}>{value}</Text>
    </View>
  );
}

// Settings-split house style — see app/(app)/settings/index.tsx makeStyles.
const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.lg, gap: t.spacing.lg, paddingBottom: 48 },

  sectionTitle: {
    fontSize: t.typography.fontSizes.caption,
    fontWeight: '700',
    color: t.colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  card: {
    backgroundColor: t.colors.surface,
    borderRadius: t.radii.lg,
    borderWidth: 1,
    borderColor: t.colors.border,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: t.spacing.base,
    paddingVertical: t.spacing.base,
  },
  rowLabel: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, fontWeight: '500' },
  rowValue: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.textPrimary },
  rowSub: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, marginTop: 2 },
  divider: { height: 1, backgroundColor: t.colors.border, marginHorizontal: t.spacing.base },
  infoBlock: { paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.md, gap: 4 },

  syncBtn: {
    margin: t.spacing.base,
    marginBottom: 0,
    backgroundColor: t.colors.primary,
    borderRadius: t.radii.md,
    paddingVertical: 12,
    alignItems: 'center',
  },
  syncBtnText: { color: t.colors.onPrimary, fontSize: t.typography.fontSizes.body, fontWeight: '700' },
  syncResult: { marginTop: 8, fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, textAlign: 'center' },
});
