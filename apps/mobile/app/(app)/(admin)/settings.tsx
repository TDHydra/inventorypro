import { useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import Constants from 'expo-constants';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { ROLE_DISPLAY_NAMES, ROLE_TIER } from '../../../src/constants/roles';
import { syncNow } from '../../../src/sync/engine';
import { getDb } from '../../../src/db/schema';
import { getIdleTimeoutMinutes, setIdleTimeoutMinutes } from '../../../src/db/appSettings';
import { setMaintenanceMode, isMaintenanceActive } from '../../../src/db/maintenance';

// ── Idle-timeout options ─────────────────────────────────────────────────────

const IDLE_OPTIONS: { label: string; value: number }[] = [
  { label: 'Off', value: 0 },
  { label: '5 min', value: 5 },
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
];

// ── DB helpers ───────────────────────────────────────────────────────────────

function readSyncStatus(): { lastSync: string; pending: number } {
  try {
    const db = getDb();
    const syncRows = db.executeSync(
      `SELECT value FROM app_settings WHERE key = 'last_pulled_at'`
    ).rows as { value: string }[];
    const lastSync = syncRows.length
      ? new Date(syncRows[0].value).toLocaleString()
      : 'Never';
    const pendingRows = db.executeSync(
      `SELECT COUNT(*) AS cnt FROM outbox WHERE synced_at IS NULL`
    ).rows as { cnt: number }[];
    const pending = pendingRows.length ? (pendingRows[0].cnt ?? 0) : 0;
    return { lastSync, pending };
  } catch {
    return { lastSync: 'Unknown', pending: 0 };
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function SettingsScreen() {
  const router = useRouter();
  const isAdmin = usePermission('system_settings');
  const { user, logout } = useSession();
  const isTier4 = user != null && ROLE_TIER[user.role] === 4;

  const [lastSync, setLastSync] = useState('Never');
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [idleMinutes, setIdleMinutes] = useState(0);
  const [maintOn, setMaintOn] = useState<boolean>(() => isMaintenanceActive());

  const refreshStatus = useCallback(() => {
    const { lastSync: ls, pending: p } = readSyncStatus();
    setLastSync(ls);
    setPending(p);
    setIdleMinutes(getIdleTimeoutMinutes());
  }, []);

  // Re-read DB values every time the screen gains focus
  useFocusEffect(
    useCallback(() => {
      refreshStatus();
      setMaintOn(isMaintenanceActive());
    }, [refreshStatus])
  );

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      await syncNow();
    } catch (err) {
      if (__DEV__) console.warn('[Settings] Sync failed:', err);
    } finally {
      setSyncing(false);
      refreshStatus();
    }
  };

  const handleSetIdle = (mins: number) => {
    try {
      setIdleTimeoutMinutes(mins);
      setIdleMinutes(mins);
    } catch (err) {
      if (__DEV__) console.warn('[Settings] Failed to save idle timeout:', err);
    }
  };

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';
  const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

  return (
    <>
      <Stack.Screen options={{ title: 'Settings', headerShown: true }} />
      <ScrollView style={s.container} contentContainerStyle={s.content}>

        {/* ── Account ──────────────────────────────────────────────────── */}
        <View>
          <Text style={s.sectionTitle}>Account</Text>
          <View style={s.card}>
            <View style={s.infoBlock}>
              <Text style={s.rowLabel}>{user?.name ?? '—'}</Text>
              <Text style={s.rowSub}>
                {user ? ROLE_DISPLAY_NAMES[user.role] : ''}
              </Text>
            </View>
            <View style={s.divider} />
            <TouchableOpacity style={s.row} onPress={logout}>
              <Text style={[s.rowLabel, s.danger]}>Log out</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* ── Sync ─────────────────────────────────────────────────────── */}
        <View>
          <Text style={s.sectionTitle}>Sync</Text>
          <View style={s.card}>
            <TouchableOpacity style={s.row} onPress={handleSyncNow} disabled={syncing}>
              <Text style={[s.rowLabel, syncing && s.muted]}>
                {syncing ? 'Syncing…' : 'Sync now'}
              </Text>
              {!syncing && <Text style={s.chevron}>↻</Text>}
            </TouchableOpacity>
            <View style={s.divider} />
            <View style={s.infoBlock}>
              <Text style={s.rowSub}>Last sync: {lastSync}</Text>
              <Text style={s.rowSub}>Pending changes: {pending}</Text>
            </View>
          </View>
        </View>

        {/* ── App info ─────────────────────────────────────────────────── */}
        <View>
          <Text style={s.sectionTitle}>App Info</Text>
          <View style={s.card}>
            <View style={s.infoBlock}>
              <Text style={s.rowSub}>Version: {appVersion}</Text>
              <Text style={s.rowSub} numberOfLines={1} ellipsizeMode="tail">
                API: {apiUrl}
              </Text>
              {user && (
                <>
                  <Text style={s.rowSub}>User ID: {user.id}</Text>
                  <Text style={s.rowSub}>Role: {ROLE_DISPLAY_NAMES[user.role]}</Text>
                </>
              )}
            </View>
          </View>
        </View>

        {/* ── Idle auto-logout ──────────────────────────────────────────── */}
        <View>
          <Text style={s.sectionTitle}>Idle Auto-logout</Text>
          <View style={s.card}>
            <View style={s.idleRow}>
              {IDLE_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={opt.value}
                  style={[s.idleChip, idleMinutes === opt.value && s.idleChipActive]}
                  onPress={() => handleSetIdle(opt.value)}
                >
                  <Text
                    style={[
                      s.idleChipText,
                      idleMinutes === opt.value && s.idleChipTextActive,
                    ]}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>

        {/* ── System (tier-4 only) ──────────────────────────────────────── */}
        {isTier4 && (
          <View>
            <Text style={s.sectionTitle}>System</Text>
            <View style={s.card}>
              <View style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>🔧 Maintenance mode</Text>
                  <Text style={s.rowSub}>
                    Locks the app to read-only for all non-admin users on every device once it syncs.
                  </Text>
                </View>
                <Switch
                  value={maintOn}
                  onValueChange={(v) => { try { setMaintenanceMode(v); setMaintOn(v); } catch { /* blocked write — ignore */ } }}
                />
              </View>
            </View>
          </View>
        )}

        {/* ── Developer Tools (admin only — keep from Phase 1) ─────────── */}
        {isAdmin && (
          <View>
            <Text style={s.sectionTitle}>Developer Tools</Text>
            <View style={s.card}>
              <TouchableOpacity
                style={s.row}
                onPress={() => router.push('/(app)/(admin)/quick-add')}
              >
                <Text style={s.rowLabel}>⚡ Quick Add</Text>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

      </ScrollView>
    </>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F8FAFF' },
  content: { padding: 16, gap: 16, paddingBottom: 48 },

  sectionTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748B',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E2E8F0',
    overflow: 'hidden',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 14,
  },
  rowLabel: { fontSize: 14, color: '#1E293B', fontWeight: '500' },
  rowSub: { fontSize: 13, color: '#64748B', marginTop: 2 },
  chevron: { fontSize: 18, color: '#94A3B8', fontWeight: '300' },
  muted: { color: '#94A3B8' },
  danger: { color: '#EF4444' },

  divider: { height: 1, backgroundColor: '#E2E8F0', marginHorizontal: 14 },

  infoBlock: { paddingHorizontal: 14, paddingVertical: 12, gap: 4 },

  // Idle-timeout chip selector
  idleRow: {
    flexDirection: 'row',
    padding: 12,
    gap: 8,
  },
  idleChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#CBD5E1',
    backgroundColor: '#F8FAFF',
    alignItems: 'center',
  },
  idleChipActive: {
    backgroundColor: '#1E3A5F',
    borderColor: '#1E3A5F',
  },
  idleChipText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#475569',
  },
  idleChipTextActive: {
    color: '#fff',
  },
});
