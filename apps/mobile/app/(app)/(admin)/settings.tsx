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
import {
  FormMode,
  getFormMode,
  getFormModeDefault,
  setFormModeDefault,
  getFormModeOverride,
  setFormModeOverride,
} from '../../../src/db/formMode';
import { colors, spacing, radii, fontSizes } from '../../../src/theme';
import { ErrorView } from '../../../src/components/ui/ErrorView';

// ── Idle-timeout options ─────────────────────────────────────────────────────

const IDLE_OPTIONS: { label: string; value: number }[] = [
  { label: 'Off', value: 0 },
  { label: '5 min', value: 5 },
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
];

const FORM_MODE_OPTIONS: { label: string; value: FormMode }[] = [
  { label: 'Simple', value: 'simple' },
  { label: 'Detailed', value: 'detailed' },
];

const FORM_OVERRIDE_OPTIONS: { label: string; value: FormMode | null }[] = [
  { label: 'Simple', value: 'simple' },
  { label: 'Detailed', value: 'detailed' },
  { label: 'Use app default', value: null },
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
  const [syncError, setSyncError] = useState<string | null>(null);
  const [idleMinutes, setIdleMinutes] = useState(0);
  const [maintOn, setMaintOn] = useState<boolean>(() => isMaintenanceActive());
  const [formDefault, setFormDefaultState] = useState<FormMode>(() => getFormModeDefault());
  const [formOverride, setFormOverrideState] = useState<FormMode | null>(() => getFormModeOverride());
  const [formResolved, setFormResolvedState] = useState<FormMode>(() => getFormMode());

  const refreshStatus = useCallback(() => {
    const { lastSync: ls, pending: p } = readSyncStatus();
    setLastSync(ls);
    setPending(p);
    setIdleMinutes(getIdleTimeoutMinutes());
    setFormDefaultState(getFormModeDefault());
    setFormOverrideState(getFormModeOverride());
    setFormResolvedState(getFormMode());
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
    setSyncError(null);
    try {
      await syncNow();
    } catch (err) {
      if (__DEV__) console.warn('[Settings] Sync failed:', err);
      setSyncError((err as Error).message ?? 'Sync failed. Check your connection and try again.');
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

  const handleSetFormDefault = (mode: FormMode) => {
    try {
      setFormModeDefault(mode);
      setFormDefaultState(mode);
      setFormResolvedState(getFormMode());
    } catch (err) {
      if (__DEV__) console.warn('[Settings] Failed to save form mode default:', err);
    }
  };

  const handleSetFormOverride = (mode: FormMode | null) => {
    try {
      setFormModeOverride(mode);
      setFormOverrideState(mode);
      setFormResolvedState(getFormMode());
    } catch (err) {
      if (__DEV__) console.warn('[Settings] Failed to save form mode override:', err);
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
          {!!syncError && (
            <ErrorView message={syncError} onRetry={handleSyncNow} />
          )}
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

        {/* ── Form detail (this device) ─────────────────────────────────── */}
        <View>
          <Text style={s.sectionTitle}>Form detail (this device)</Text>
          <View style={s.card}>
            <View style={s.idleRow}>
              {FORM_OVERRIDE_OPTIONS.map(opt => (
                <TouchableOpacity
                  key={opt.label}
                  style={[s.idleChip, formOverride === opt.value && s.idleChipActive]}
                  onPress={() => handleSetFormOverride(opt.value)}
                >
                  <Text
                    style={[
                      s.idleChipText,
                      formOverride === opt.value && s.idleChipTextActive,
                    ]}
                  >
                    {opt.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={s.divider} />
            <View style={s.infoBlock}>
              <Text style={s.rowSub}>
                Effective: {formResolved === 'simple' ? 'Simple' : 'Detailed'}
              </Text>
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
              <View style={s.divider} />
              <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.base }}>
                <Text style={s.rowLabel}>Default form mode</Text>
                <Text style={s.rowSub}>Applies to all devices unless a user overrides it.</Text>
              </View>
              <View style={s.idleRow}>
                {FORM_MODE_OPTIONS.map(opt => (
                  <TouchableOpacity
                    key={opt.value}
                    style={[s.idleChip, formDefault === opt.value && s.idleChipActive]}
                    onPress={() => handleSetFormDefault(opt.value)}
                  >
                    <Text
                      style={[
                        s.idleChipText,
                        formDefault === opt.value && s.idleChipTextActive,
                      ]}
                    >
                      {opt.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={s.divider} />
              <TouchableOpacity
                style={s.row}
                onPress={() => router.push('/(app)/(admin)/manage-types')}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>⚙️ Manage Types</Text>
                  <Text style={s.rowSub}>Edit team & job types (label + icon), synced to all devices.</Text>
                </View>
                <Text style={s.rowSub}>›</Text>
              </TouchableOpacity>
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
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 48 },

  sectionTitle: {
    fontSize: fontSizes.caption,
    fontWeight: '700',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.base,
  },
  rowLabel: { fontSize: fontSizes.body, color: colors.textPrimary, fontWeight: '500' },
  rowSub: { fontSize: fontSizes.body2, color: colors.textSecondary, marginTop: 2 },
  chevron: { fontSize: 18, color: colors.textMuted, fontWeight: '300' },
  muted: { color: colors.textMuted },
  danger: { color: colors.danger },

  divider: { height: 1, backgroundColor: colors.border, marginHorizontal: spacing.base },

  infoBlock: { paddingHorizontal: spacing.base, paddingVertical: spacing.md, gap: 4 },

  // Idle-timeout chip selector
  idleRow: {
    flexDirection: 'row',
    padding: spacing.md,
    gap: 8,
  },
  idleChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.textDisabled,
    backgroundColor: colors.background,
    alignItems: 'center',
  },
  idleChipActive: {
    backgroundColor: colors.brand,
    borderColor: colors.brand,
  },
  idleChipText: {
    fontSize: fontSizes.body2,
    fontWeight: '600',
    color: '#475569',
  },
  idleChipTextActive: {
    color: '#fff',
  },
});
