import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable } from 'react-native';
import { Alert } from '../lib/themedAlert';
import { getDb } from '../db/schema';
import { getOutboxCounts, getFailedOutbox, retryFailedOutbox, discardFailedOutbox } from '../sync/outbox';
import { syncNow } from '../sync/engine';
import type { Theme } from '../themes/types';
import { useTheme } from '../hooks/useTheme';
import { useThemedStyles } from '../hooks/useThemedStyles';

type SyncStatus = 'synced' | 'pending' | 'failed' | 'offline';

export function SyncIndicator() {
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const [status, setStatus] = useState<SyncStatus>('synced');
  const [active, setActive] = useState(0);
  const [failed, setFailed] = useState(0);
  const [firstError, setFirstError] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [showSheet, setShowSheet] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const interval = setInterval(refresh, 5000);
    refresh();
    return () => clearInterval(interval);
  }, []);

  function refresh() {
    try {
      // active = still retrying; failed = retry-exhausted (the entries that used
      // to pin this indicator "pending" forever with no way to clear them).
      const { active: a, failed: f } = getOutboxCounts();
      setActive(a);
      setFailed(f);
      if (f > 0) {
        const first = getFailedOutbox(1)[0];
        setFirstError(first ? `${first.operation} ${first.table_name}: ${first.last_error ?? 'rejected'}` : null);
      } else {
        setFirstError(null);
      }

      const settingResult = getDb().executeSync(
        `SELECT value FROM app_settings WHERE key = 'last_pulled_at'`
      );
      setLastSync((settingResult.rows[0] as { value: string } | undefined)?.value ?? null);

      setStatus(f > 0 ? 'failed' : a > 0 ? 'pending' : 'synced');
    } catch {
      setStatus('offline');
    }
  }

  async function handleRetry() {
    setBusy(true);
    try {
      const n = retryFailedOutbox();
      await syncNow();
      refresh();
      Alert.alert('Retrying', n > 0 ? `Re-queued ${n} failed change${n !== 1 ? 's' : ''}.` : 'Nothing to retry.');
    } catch {
      Alert.alert('Retry failed', 'Could not reach the server. It will keep trying.');
    } finally {
      setBusy(false);
    }
  }

  function handleDiscard() {
    Alert.alert(
      'Discard failed changes?',
      `Permanently drop ${failed} change${failed !== 1 ? 's' : ''} that could not be uploaded. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Discard', style: 'destructive',
          onPress: () => { discardFailedOutbox(); refresh(); },
        },
      ],
    );
  }

  const SYNC_COLORS: Record<SyncStatus, string> = {
    synced: t.colors.success,
    pending: t.colors.warning,
    failed: t.colors.danger,
    offline: t.colors.danger,
  };
  const color = SYNC_COLORS[status];
  const label = {
    synced: 'Synced',
    pending: `${active} pending`,
    failed: `${failed} failed`,
    offline: 'Offline',
  }[status];

  return (
    <>
      <TouchableOpacity onPress={() => { refresh(); setShowSheet(true); }} style={s.dot}>
        <View style={[s.circle, { backgroundColor: color }]} />
      </TouchableOpacity>

      <Modal visible={showSheet} transparent animationType="slide">
        <Pressable style={s.overlay} onPress={() => setShowSheet(false)}>
          <Pressable style={s.sheet}>
            <View style={[s.sheetDot, { backgroundColor: color }]} />
            <Text style={s.sheetStatus}>{label}</Text>
            {lastSync && (
              <Text style={s.sheetSub}>
                Last sync: {new Date(lastSync).toLocaleTimeString()}
              </Text>
            )}
            {active > 0 && (
              <Text style={s.sheetSub}>
                {active} change{active !== 1 ? 's' : ''} waiting to upload
              </Text>
            )}
            {failed > 0 && (
              <>
                <Text style={s.sheetFailed}>
                  {failed} change{failed !== 1 ? 's' : ''} failed to sync after several tries.
                </Text>
                {firstError && <Text style={s.sheetErr} numberOfLines={3}>{firstError}</Text>}
                <View style={s.btnRow}>
                  <TouchableOpacity
                    style={[s.btn, s.btnPrimary, busy && s.btnDisabled]}
                    onPress={handleRetry}
                    disabled={busy}
                  >
                    <Text style={s.btnPrimaryText}>{busy ? 'Retrying…' : 'Retry now'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[s.btn, s.btnDanger]}
                    onPress={handleDiscard}
                    disabled={busy}
                  >
                    <Text style={s.btnDangerText}>Discard</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
            {status === 'offline' && (
              <Text style={s.sheetOffline}>
                Connect to WiFi or cellular to sync your changes.
              </Text>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  dot: { padding: 6 },
  circle: { width: 10, height: 10, borderRadius: 5 },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: {
    backgroundColor: t.colors.surface,
    borderTopLeftRadius: t.radii.xl,
    borderTopRightRadius: t.radii.xl,
    padding: t.spacing.xxl,
    alignItems: 'center',
    gap: t.spacing.sm,
  },
  sheetDot: { width: 16, height: 16, borderRadius: 8, marginBottom: 4 },
  sheetStatus: { fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary },
  sheetSub: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary },
  sheetFailed: { fontSize: t.typography.fontSizes.body, color: t.colors.danger, textAlign: 'center', marginTop: 4, fontWeight: '600' },
  sheetErr: { fontSize: t.typography.fontSizes.caption, color: t.colors.textMuted, textAlign: 'center', fontStyle: 'italic' },
  sheetOffline: { fontSize: t.typography.fontSizes.body2, color: t.colors.danger, textAlign: 'center', marginTop: 4 },
  btnRow: { flexDirection: 'row', gap: t.spacing.md, marginTop: t.spacing.md },
  btn: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: t.radii.md, minWidth: 110, alignItems: 'center' },
  btnPrimary: { backgroundColor: t.colors.primary },
  btnPrimaryText: { color: t.colors.surface, fontWeight: '700', fontSize: t.typography.fontSizes.body },
  btnDanger: { backgroundColor: t.colors.dangerBg },
  btnDangerText: { color: t.colors.danger, fontWeight: '700', fontSize: t.typography.fontSizes.body },
  btnDisabled: { opacity: 0.6 },
});
