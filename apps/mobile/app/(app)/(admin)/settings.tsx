import { useState, useCallback, useMemo } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import Constants from 'expo-constants';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useFocusRefresh } from '../../../src/hooks/useFocusRefresh';
import { ROLE_DISPLAY_NAMES, ROLE_TIER } from '../../../src/constants/roles';
import { syncNow } from '../../../src/sync/engine';
import { getDb } from '../../../src/db/schema';
import { getIdleTimeoutMinutes, setIdleTimeoutMinutes, getAppSetting, setAppSetting } from '../../../src/db/appSettings';
import { ensureNotificationPermission } from '../../../src/notifications/localAlerts';
import { setMaintenanceMode, isMaintenanceActive } from '../../../src/db/maintenance';
import { getAppConfig, setAppConfigLocal } from '../../../src/db/appConfig';
import { appendOutbox } from '../../../src/sync/outbox';
import { AppInput } from '../../../src/components/ui/AppInput';
import {
  FormMode,
  getFormMode,
  getFormModeDefault,
  setFormModeDefault,
  getFormModeOverride,
  setFormModeOverride,
} from '../../../src/db/formMode';
import { getMainStorageLocationId, setMainStorageLocation } from '../../../src/db/mainStorage';
import { getAllLocations, getShelvesForParent, resolveLocationShelf } from '../../../src/db/queries/locations';
import { SearchablePicker } from '../../../src/components/SearchablePicker';
import type { PickerOption } from '../../../src/components/SearchablePicker';
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

// ── Notification trigger config keys (app_config, admin-editable) ──────────

const NOTIFY_ENABLED_KEY = 'notify_enabled';
const NOTIFY_POLL_MIN_KEY = 'notify_poll_interval_min';
const NOTIFY_IDLE_MIN_KEY = 'notify_checkout_idle_min';

// ── DB helpers ───────────────────────────────────────────────────────────────

/**
 * Writes a synced `app_config` value: locally + through the outbox so it
 * reaches the server (same write path as `setMaintenanceMode` — INSERT is the
 * outbox's full-row upsert op; the server applies ON CONFLICT (key) DO UPDATE).
 */
function setAppConfigSynced(key: string, value: string): void {
  setAppConfigLocal(key, value);
  appendOutbox('INSERT', 'app_config', {
    key,
    value,
    updated_at: new Date().toISOString(),
  });
}

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
  const refreshKey = useFocusRefresh();

  const [lastSync, setLastSync] = useState('Never');
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [idleMinutes, setIdleMinutes] = useState(0);
  // Default ON when the pref is unset.
  const [notifEnabled, setNotifEnabled] = useState<boolean>(() => getAppSetting('notifications_enabled') !== 'false');
  const [maintOn, setMaintOn] = useState<boolean>(() => isMaintenanceActive());
  // Notification trigger config (admin, synced) — defaults mirror getNotifyConfig() on the API.
  const [notifyTriggersOn, setNotifyTriggersOn] = useState<boolean>(() => getAppConfig(NOTIFY_ENABLED_KEY) !== '0');
  const [pollMinInput, setPollMinInput] = useState<string>(() => getAppConfig(NOTIFY_POLL_MIN_KEY) ?? '5');
  const [idleMinInput, setIdleMinInput] = useState<string>(() => getAppConfig(NOTIFY_IDLE_MIN_KEY) ?? '15');
  const [formDefault, setFormDefaultState] = useState<FormMode>(() => getFormModeDefault());
  const [formOverride, setFormOverrideState] = useState<FormMode | null>(() => getFormModeOverride());
  const [formResolved, setFormResolvedState] = useState<FormMode>(() => getFormMode());

  // Main storage area (app-wide default stock location). Two-stage like Quick Add:
  // a location, plus a shelf when that location has shelves. Stored as a single id
  // (the shelf id when a shelf is chosen, else the location id).
  const [storageLoc, setStorageLoc] = useState<PickerOption | null>(() => resolveLocationShelf(getMainStorageLocationId()).location);
  const [storageShelf, setStorageShelf] = useState<PickerOption | null>(() => resolveLocationShelf(getMainStorageLocationId()).shelf);
  const allLocations = useMemo(() => getAllLocations(), [refreshKey]);
  const locationById = useMemo(() => new Map(allLocations.map(l => [l.id, l])), [allLocations]);
  const locationOptions = useMemo<PickerOption[]>(
    () => allLocations.map(l => ({ id: l.id, label: l.name, sublabel: l.parent_id ? locationById.get(l.parent_id)?.name : undefined })),
    [allLocations, locationById],
  );
  const storageLocHasShelves = (storageLoc ? locationById.get(storageLoc.id) : undefined)?.has_shelves === 1;
  const storageShelfOptions = useMemo<PickerOption[]>(
    () => (storageLocHasShelves && storageLoc) ? getShelvesForParent(storageLoc.id).map(s => ({ id: s.id, label: s.name })) : [],
    [storageLocHasShelves, storageLoc],
  );

  // Pick a storage location: toggle off if re-tapped (clears the setting); else set
  // it and reset the shelf. The location id is stored immediately (shelf optional).
  function handleStorageLocationSelect(opt: PickerOption) {
    if (storageLoc?.id === opt.id) {
      setStorageLoc(null);
      setStorageShelf(null);
      try { setMainStorageLocation(null); } catch { /* blocked write — ignore */ }
      return;
    }
    setStorageLoc(opt);
    setStorageShelf(null);
    try { setMainStorageLocation(opt.id); } catch { /* blocked write — ignore */ }
  }

  // Pick/clear a shelf within the storage location → store the shelf id (or fall
  // back to the location id when the shelf is cleared).
  function handleStorageShelfSelect(opt: PickerOption) {
    const next = storageShelf?.id === opt.id ? null : opt;
    setStorageShelf(next);
    try { setMainStorageLocation(next ? next.id : (storageLoc?.id ?? null)); } catch { /* blocked write — ignore */ }
  }

  const refreshStatus = useCallback(() => {
    const { lastSync: ls, pending: p } = readSyncStatus();
    setLastSync(ls);
    setPending(p);
    setIdleMinutes(getIdleTimeoutMinutes());
    setNotifEnabled(getAppSetting('notifications_enabled') !== 'false');
    setFormDefaultState(getFormModeDefault());
    setFormOverrideState(getFormModeOverride());
    setFormResolvedState(getFormMode());
    const st = resolveLocationShelf(getMainStorageLocationId());
    setStorageLoc(st.location);
    setStorageShelf(st.shelf);
  }, []);

  // Re-read DB values every time the screen gains focus
  useFocusEffect(
    useCallback(() => {
      refreshStatus();
      setMaintOn(isMaintenanceActive());
      setNotifyTriggersOn(getAppConfig(NOTIFY_ENABLED_KEY) !== '0');
      setPollMinInput(getAppConfig(NOTIFY_POLL_MIN_KEY) ?? '5');
      setIdleMinInput(getAppConfig(NOTIFY_IDLE_MIN_KEY) ?? '15');
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

  const handleToggleNotifications = async (enabled: boolean) => {
    try {
      setAppSetting('notifications_enabled', enabled ? 'true' : 'false');
      setNotifEnabled(enabled);
      // Turning ON: make sure we actually hold OS permission, otherwise nothing
      // will surface. If denied, point the user at the OS settings.
      if (enabled) {
        const granted = await ensureNotificationPermission();
        if (!granted) {
          Alert.alert(
            'Notifications are off',
            'To get low-stock and expiry alerts, enable notifications for InventoryPro in your device Settings.'
          );
        }
      }
    } catch (err) {
      if (__DEV__) console.warn('[Settings] Failed to toggle notifications:', err);
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

  const handleToggleNotifyTriggers = (enabled: boolean) => {
    try {
      setAppConfigSynced(NOTIFY_ENABLED_KEY, enabled ? '1' : '0');
      setNotifyTriggersOn(enabled);
    } catch (err) {
      if (__DEV__) console.warn('[Settings] Failed to toggle notify_enabled:', err);
    }
  };

  // Commits a numeric app_config field on blur: parses to an integer >= 1,
  // reverting the field to its last-known-good value on invalid input.
  const commitNotifyIntConfig = (
    key: string,
    text: string,
    fallback: string,
    setInput: (v: string) => void
  ) => {
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n < 1) {
      setInput(fallback);
      return;
    }
    const value = String(n);
    try {
      setAppConfigSynced(key, value);
    } catch (err) {
      if (__DEV__) console.warn(`[Settings] Failed to save ${key}:`, err);
    }
    setInput(value);
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

        {/* ── Notifications ─────────────────────────────────────────────── */}
        <View>
          <Text style={s.sectionTitle}>Notifications</Text>
          <View style={s.card}>
            <View style={s.row}>
              <View style={{ flex: 1 }}>
                <Text style={s.rowLabel}>Stock & expiry alerts</Text>
                <Text style={s.rowSub}>
                  Get a notification when an item runs low or a temporary employee's access is about to expire.
                </Text>
              </View>
              <Switch
                value={notifEnabled}
                onValueChange={(v) => { void handleToggleNotifications(v); }}
              />
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
              <View style={{ paddingHorizontal: spacing.base, paddingTop: spacing.base }}>
                <Text style={s.rowLabel}>Main storage area</Text>
                <Text style={s.rowSub}>New stock (e.g. Quick Add) defaults to this location. Pick a shelf if the area has them.</Text>
                <View style={{ marginTop: spacing.sm }}>
                  <SearchablePicker
                    placeholder="Search locations…"
                    options={locationOptions}
                    value={storageLoc}
                    onSelect={handleStorageLocationSelect}
                  />
                  {storageLocHasShelves && (
                    <View style={{ marginTop: spacing.sm }}>
                      <SearchablePicker
                        placeholder="Pick a shelf (e.g. A1)…"
                        options={storageShelfOptions}
                        value={storageShelf}
                        onSelect={handleStorageShelfSelect}
                      />
                    </View>
                  )}
                </View>
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

        {/* ── Notification Triggers (admin only — server push config) ──── */}
        {isAdmin && (
          <View>
            <Text style={s.sectionTitle}>Notification Triggers</Text>
            <View style={s.card}>
              <View style={s.row}>
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>Enable push triggers</Text>
                  <Text style={s.rowSub}>
                    Assignment, low-stock, and checkout-idle pushes. Turning this off stops all three server-side.
                  </Text>
                </View>
                <Switch
                  value={notifyTriggersOn}
                  onValueChange={handleToggleNotifyTriggers}
                />
              </View>
              <View style={s.divider} />
              <View style={{ paddingHorizontal: spacing.base, paddingVertical: spacing.base, gap: spacing.sm }}>
                <Text style={s.rowLabel}>Poll interval (minutes)</Text>
                <Text style={s.rowSub}>How often the server checks for checkout-idle sessions.</Text>
                <AppInput
                  value={pollMinInput}
                  onChangeText={setPollMinInput}
                  onEndEditing={() => commitNotifyIntConfig(NOTIFY_POLL_MIN_KEY, pollMinInput, getAppConfig(NOTIFY_POLL_MIN_KEY) ?? '5', setPollMinInput)}
                  keyboardType="number-pad"
                  style={{ width: 100 }}
                />
              </View>
              <View style={s.divider} />
              <View style={{ paddingHorizontal: spacing.base, paddingVertical: spacing.base, gap: spacing.sm }}>
                <Text style={s.rowLabel}>Checkout idle timeout (minutes)</Text>
                <Text style={s.rowSub}>How long after a user's last checkout before their manager is notified.</Text>
                <AppInput
                  value={idleMinInput}
                  onChangeText={setIdleMinInput}
                  onEndEditing={() => commitNotifyIntConfig(NOTIFY_IDLE_MIN_KEY, idleMinInput, getAppConfig(NOTIFY_IDLE_MIN_KEY) ?? '15', setIdleMinInput)}
                  keyboardType="number-pad"
                  style={{ width: 100 }}
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
                onPress={() => router.push('/(app)/(quickadd)')}
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
