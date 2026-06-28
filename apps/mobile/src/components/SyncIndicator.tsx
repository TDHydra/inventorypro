import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable, Alert } from 'react-native';
import { getDb } from '../db/schema';
import { getOutboxCounts, getFailedOutbox, retryFailedOutbox, discardFailedOutbox } from '../sync/outbox';
import { syncNow } from '../sync/engine';

type SyncStatus = 'synced' | 'pending' | 'failed' | 'offline';

export function SyncIndicator() {
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

  const color = { synced: '#22C55E', pending: '#F59E0B', failed: '#EF4444', offline: '#EF4444' }[status];
  const label = {
    synced: 'Synced',
    pending: `${active} pending`,
    failed: `${failed} failed`,
    offline: 'Offline',
  }[status];

  return (
    <>
      <TouchableOpacity onPress={() => { refresh(); setShowSheet(true); }} style={styles.dot}>
        <View style={[styles.circle, { backgroundColor: color }]} />
      </TouchableOpacity>

      <Modal visible={showSheet} transparent animationType="slide">
        <Pressable style={styles.overlay} onPress={() => setShowSheet(false)}>
          <Pressable style={styles.sheet}>
            <View style={[styles.sheetDot, { backgroundColor: color }]} />
            <Text style={styles.sheetStatus}>{label}</Text>
            {lastSync && (
              <Text style={styles.sheetSub}>
                Last sync: {new Date(lastSync).toLocaleTimeString()}
              </Text>
            )}
            {active > 0 && (
              <Text style={styles.sheetSub}>
                {active} change{active !== 1 ? 's' : ''} waiting to upload
              </Text>
            )}
            {failed > 0 && (
              <>
                <Text style={styles.sheetFailed}>
                  {failed} change{failed !== 1 ? 's' : ''} failed to sync after several tries.
                </Text>
                {firstError && <Text style={styles.sheetErr} numberOfLines={3}>{firstError}</Text>}
                <View style={styles.btnRow}>
                  <TouchableOpacity
                    style={[styles.btn, styles.btnPrimary, busy && styles.btnDisabled]}
                    onPress={handleRetry}
                    disabled={busy}
                  >
                    <Text style={styles.btnPrimaryText}>{busy ? 'Retrying…' : 'Retry now'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.btn, styles.btnDanger]}
                    onPress={handleDiscard}
                    disabled={busy}
                  >
                    <Text style={styles.btnDangerText}>Discard</Text>
                  </TouchableOpacity>
                </View>
              </>
            )}
            {status === 'offline' && (
              <Text style={styles.sheetOffline}>
                Connect to WiFi or cellular to sync your changes.
              </Text>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  dot: { padding: 6 },
  circle: { width: 10, height: 10, borderRadius: 5 },
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.3)' },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  sheetDot: { width: 16, height: 16, borderRadius: 8, marginBottom: 4 },
  sheetStatus: { fontSize: 18, fontWeight: '700', color: '#1E293B' },
  sheetSub: { fontSize: 14, color: '#64748B' },
  sheetFailed: { fontSize: 14, color: '#DC2626', textAlign: 'center', marginTop: 4, fontWeight: '600' },
  sheetErr: { fontSize: 12, color: '#94A3B8', textAlign: 'center', fontStyle: 'italic' },
  sheetOffline: { fontSize: 13, color: '#DC2626', textAlign: 'center', marginTop: 4 },
  btnRow: { flexDirection: 'row', gap: 12, marginTop: 12 },
  btn: { paddingVertical: 10, paddingHorizontal: 20, borderRadius: 10, minWidth: 110, alignItems: 'center' },
  btnPrimary: { backgroundColor: '#1E7E4E' },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  btnDanger: { backgroundColor: '#FEE2E2' },
  btnDangerText: { color: '#DC2626', fontWeight: '700', fontSize: 14 },
  btnDisabled: { opacity: 0.6 },
});
