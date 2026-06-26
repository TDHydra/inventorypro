import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Pressable } from 'react-native';
import { getDb } from '../db/schema';

type SyncStatus = 'synced' | 'pending' | 'offline';

export function SyncIndicator() {
  const [status, setStatus] = useState<SyncStatus>('synced');
  const [pendingCount, setPendingCount] = useState(0);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [showSheet, setShowSheet] = useState(false);

  useEffect(() => {
    const interval = setInterval(refresh, 5000);
    refresh();
    return () => clearInterval(interval);
  }, []);

  function refresh() {
    try {
      const db = getDb();
      const result = db.executeSync(
        `SELECT COUNT(*) as cnt FROM outbox WHERE synced_at IS NULL`
      );
      const count = (result.rows[0] as { cnt: number }).cnt ?? 0;
      setPendingCount(count);

      const settingResult = db.executeSync(
        `SELECT value FROM app_settings WHERE key = 'last_pulled_at'`
      );
      setLastSync((settingResult.rows[0] as { value: string } | undefined)?.value ?? null);

      // Status logic: offline detection happens in sync engine
      // For now use outbox count as proxy
      setStatus(count > 0 ? 'pending' : 'synced');
    } catch {
      setStatus('offline');
    }
  }

  const color = { synced: '#22C55E', pending: '#F59E0B', offline: '#EF4444' }[status];
  const label = { synced: 'Synced', pending: `${pendingCount} pending`, offline: 'Offline' }[status];

  return (
    <>
      <TouchableOpacity onPress={() => setShowSheet(true)} style={styles.dot}>
        <View style={[styles.circle, { backgroundColor: color }]} />
      </TouchableOpacity>

      <Modal visible={showSheet} transparent animationType="slide">
        <Pressable style={styles.overlay} onPress={() => setShowSheet(false)}>
          <View style={styles.sheet}>
            <View style={[styles.sheetDot, { backgroundColor: color }]} />
            <Text style={styles.sheetStatus}>{label}</Text>
            {lastSync && (
              <Text style={styles.sheetSub}>
                Last sync: {new Date(lastSync).toLocaleTimeString()}
              </Text>
            )}
            {pendingCount > 0 && (
              <Text style={styles.sheetSub}>
                {pendingCount} change{pendingCount !== 1 ? 's' : ''} waiting to upload
              </Text>
            )}
            {status === 'offline' && (
              <Text style={styles.sheetOffline}>
                Connect to WiFi or cellular to sync your changes.
              </Text>
            )}
          </View>
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
  sheetOffline: { fontSize: 13, color: '#DC2626', textAlign: 'center', marginTop: 4 },
});
