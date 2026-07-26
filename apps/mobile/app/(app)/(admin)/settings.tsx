import { useState, useCallback, useMemo, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import { Alert } from '../../../src/lib/themedAlert';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import Constants from 'expo-constants';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import { ROLE_DISPLAY_NAMES, ROLE_TIER } from '../../../src/constants/roles';
import { syncNow } from '../../../src/sync/engine';
import { getDb } from '../../../src/db/schema';
import { getIdleTimeoutMinutes, setIdleTimeoutMinutes, getAppSetting, setAppSetting } from '../../../src/db/appSettings';
import { ensureNotificationPermission } from '../../../src/notifications/localAlerts';
import { generateSampleData } from '../../../src/dev/generateSampleData';
import { bumpDataVersion } from '../../../src/sync/dataVersion';
import { setMaintenanceMode, isMaintenanceActive } from '../../../src/db/maintenance';
import { getAppConfig, setAppConfigLocal } from '../../../src/db/appConfig';
import { appendOutbox } from '../../../src/sync/outbox';
import { AppInput } from '../../../src/components/ui/AppInput';
import { FormScreen } from '../../../src/components/ui/FormScreen';
import {
  FormMode,
  getFormMode,
  getFormModeDefault,
  setFormModeDefault,
  getFormModeOverride,
  setFormModeOverride,
} from '../../../src/db/formMode';
import { getMainStorageLocationId, setMainStorageLocation } from '../../../src/db/mainStorage';
import { getNonShelfLocations, getShelvesForParent, resolveLocationShelf } from '../../../src/db/queries/locations';
import { getValidJwt } from '../../../src/auth/session';
import { SearchablePicker } from '../../../src/components/SearchablePicker';
import type { PickerOption } from '../../../src/components/SearchablePicker';
import { QrSigningSection } from '../../../src/components/QrSigningSection';
import { ProfileSection } from '../../../src/components/profile/ProfileSection';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';
import { ErrorView } from '../../../src/components/ui/ErrorView';
import { useTheme } from '../../../src/hooks/useTheme';
import { themeList } from '../../../src/themes/registry';
import { chooseTheme } from '../../../src/db/userPrefs';
import { getOrgDefaultThemeId, setOrgDefaultTheme } from '../../../src/db/orgTheme';

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
// Approval workflow: movements whose |qty| >= this value auto-flag an approval
// request server-side. Blank/0 disables the auto-flag.
const APPROVAL_THRESHOLD_KEY = 'approval_threshold_qty';

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
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const router = useRouter();
  const isAdmin = usePermission('system_settings');
  const canBroadcast = usePermission('send_notifications');
  const canViewAudit = usePermission('view_audit_log');
  const { user, logout } = useSession();
  const activeThemeId = t.id;
  const isTier4 = user != null && ROLE_TIER[user.role] === 4;
  // Demo-accounts kill switch is apex-only — full_admin exactly, NOT tier-4 peers.
  const isApex = user?.role === 'full_admin';
  const refreshKey = useFocusOrDataRefresh();

  const [lastSync, setLastSync] = useState('Never');
  const [pending, setPending] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [idleMinutes, setIdleMinutes] = useState(0);
  // Default ON when the pref is unset.
  const [notifEnabled, setNotifEnabled] = useState<boolean>(() => getAppSetting('notifications_enabled') !== 'false');
  const [maintOn, setMaintOn] = useState<boolean>(() => isMaintenanceActive());
  // Demo accounts master switch (server-side, live): null until GET /audit/demo-mode resolves.
  const [demoOn, setDemoOn] = useState<boolean | null>(null);
  // Notification trigger config (admin, synced) — defaults mirror getNotifyConfig() on the API.
  const [notifyTriggersOn, setNotifyTriggersOn] = useState<boolean>(() => getAppConfig(NOTIFY_ENABLED_KEY) !== '0');
  const [pollMinInput, setPollMinInput] = useState<string>(() => getAppConfig(NOTIFY_POLL_MIN_KEY) ?? '5');
  const [idleMinInput, setIdleMinInput] = useState<string>(() => getAppConfig(NOTIFY_IDLE_MIN_KEY) ?? '15');
  const [thresholdInput, setThresholdInput] = useState<string>(() => getAppConfig(APPROVAL_THRESHOLD_KEY) ?? '');
  // Org default theme (Phase E, #138): app_config 'default_theme_id', synced.
  const [orgThemeId, setOrgThemeId] = useState<string | null>(() => getOrgDefaultThemeId());
  const [formDefault, setFormDefaultState] = useState<FormMode>(() => getFormModeDefault());
  const [formOverride, setFormOverrideState] = useState<FormMode | null>(() => getFormModeOverride());
  const [formResolved, setFormResolvedState] = useState<FormMode>(() => getFormMode());

  // Main storage area (app-wide default stock location). Two-stage like Quick Add:
  // a location, plus a shelf when that location has shelves. Stored as a single id
  // (the shelf id when a shelf is chosen, else the location id).
  const [storageLoc, setStorageLoc] = useState<PickerOption | null>(() => resolveLocationShelf(getMainStorageLocationId()).location);
  const [storageShelf, setStorageShelf] = useState<PickerOption | null>(() => resolveLocationShelf(getMainStorageLocationId()).shelf);
  // Shelves are only reachable through the shelf sub-picker of their parent,
  // never as a first-class storage location (#70).
  const allLocations = useMemo(() => getNonShelfLocations(), [refreshKey]);
  const locationById = useMemo(() => new Map(allLocations.map(l => [l.id, l])), [allLocations]);
  const locationOptions = useMemo<PickerOption[]>(
    () => allLocations.map(l => ({ id: l.id, label: l.name, sublabel: l.parent_id ? locationById.get(l.parent_id)?.name : undefined })),
    [allLocations, locationById],
  );

  // Dev tool (#24): populate the local sandbox with sample data. Guarded to test
  // accounts so it can never write to production — generateSampleData enforces the
  // same guard, and a test account's /sync/push is 403'd server-side regardless.
  const handleGenerateSampleData = useCallback(() => {
    if (!user?.is_test) {
      Alert.alert(
        'Test accounts only',
        'Sample data generation is only available on a test / sandbox account, so it can never write to production.',
      );
      return;
    }
    Alert.alert(
      'Generate sample data?',
      'Adds 5 sample locations and 5 sample items (with stock) to THIS device only. It stays in the sandbox and never syncs to production.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Generate',
          onPress: () => {
            try {
              const r = generateSampleData({ isTest: true, count: 5 });
              bumpDataVersion();
              Alert.alert(
                'Sample data created',
                `Added ${r.locations} locations and ${r.items} items (${r.stockRows} with stock).`,
              );
            } catch (e) {
              Alert.alert('Could not generate', (e as Error).message);
            }
          },
        },
      ],
    );
  }, [user?.is_test]);
  const storageLocHasShelves = (storageLoc ? locationById.get(storageLoc.id) : undefined)?.has_shelves === 1;
  const storageShelfOptions = useMemo<PickerOption[]>(
    () => (storageLocHasShelves && storageLoc) ? getShelvesForParent(storageLoc.id).map(s => ({ id: s.id, label: s.name })) : [],
    [storageLocHasShelves, storageLoc, refreshKey],
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

  // Re-read live while the screen is open: refreshKey bumps on refocus AND on
  // data-version ticks, so synced app_config/app_settings changes show without
  // leaving the screen. The notify text inputs stay focus-seeded below so
  // in-progress typing is never clobbered by a background pull.
  useEffect(() => { refreshStatus(); }, [refreshStatus, refreshKey]);

  // Re-read DB values every time the screen gains focus
  useFocusEffect(
    useCallback(() => {
      refreshStatus();
      setMaintOn(isMaintenanceActive());
      setNotifyTriggersOn(getAppConfig(NOTIFY_ENABLED_KEY) !== '0');
      setPollMinInput(getAppConfig(NOTIFY_POLL_MIN_KEY) ?? '5');
      setIdleMinInput(getAppConfig(NOTIFY_IDLE_MIN_KEY) ?? '15');
      setThresholdInput(getAppConfig(APPROVAL_THRESHOLD_KEY) ?? '');
      setOrgThemeId(getOrgDefaultThemeId());
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

  // Load the server-side demo-mode flag once (apex only). Live data, not
  // synced: the switch stays disabled (null) while offline or unauthorized.
  useEffect(() => {
    if (!isApex) return;
    let cancelled = false;
    (async () => {
      try {
        const jwt = await getValidJwt();
        if (!jwt) return;
        const res = await fetch(`${apiUrl}/audit/demo-mode`, {
          headers: { Authorization: `Bearer ${jwt}` },
        });
        if (!res.ok) return;
        const body = (await res.json()) as { enabled: boolean };
        if (!cancelled) setDemoOn(body.enabled);
      } catch {
        // Offline — leave the switch disabled.
      }
    })();
    return () => { cancelled = true; };
  }, [isApex]);

  const handleToggleDemoMode = async (enabled: boolean) => {
    const prev = demoOn;
    setDemoOn(enabled); // optimistic — reverted below on failure
    try {
      const jwt = await getValidJwt();
      if (!jwt) throw new Error('Sign in required.');
      const res = await fetch(`${apiUrl}/audit/demo-mode`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        throw new Error(
          res.status === 403
            ? 'Only a full admin can change demo mode.'
            : 'The server rejected the change. Please try again.'
        );
      }
      const body = (await res.json()) as { enabled: boolean };
      setDemoOn(body.enabled);
    } catch (err) {
      setDemoOn(prev);
      Alert.alert(
        'Could not update demo accounts',
        err instanceof Error ? err.message : 'Check your connection and try again.',
      );
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

  // Commits a numeric app_config field on blur: parses to an integer in
  // [1, 1440] minutes, reverting the field to its last-known-good value on
  // invalid input. The upper bound mirrors the server clamp (getNotifyConfig) —
  // huge values would otherwise overflow the timer's interval or make the
  // checkout-idle check unsatisfiable.
  const commitNotifyIntConfig = (
    key: string,
    text: string,
    fallback: string,
    setInput: (v: string) => void
  ) => {
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
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

  // Commits the approval threshold on blur. Blank clears it (auto-flag off);
  // otherwise it must be a positive integer. Reverts to last-known-good on
  // invalid non-blank input.
  const commitApprovalThreshold = () => {
    const t = thresholdInput.trim();
    if (t === '') {
      try { setAppConfigSynced(APPROVAL_THRESHOLD_KEY, ''); } catch (err) { if (__DEV__) console.warn('[Settings] Failed to clear approval threshold:', err); }
      setThresholdInput('');
      return;
    }
    const n = parseInt(t, 10);
    if (!Number.isFinite(n) || n < 1 || n > 100000) {
      setThresholdInput(getAppConfig(APPROVAL_THRESHOLD_KEY) ?? '');
      return;
    }
    const value = String(n);
    try { setAppConfigSynced(APPROVAL_THRESHOLD_KEY, value); } catch (err) { if (__DEV__) console.warn('[Settings] Failed to save approval threshold:', err); }
    setThresholdInput(value);
  };

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';
  const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

  return (
    <>
      <Stack.Screen options={{ title: 'Settings', headerShown: true }} />
      <FormScreen contentContainerStyle={s.content}>

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

        {/* ── My Profile (ALL roles — self-service PIN / email / phone) ── */}
        <ProfileSection />

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

        {/* ── Theme (per user, synced) ──────────────────────────────────── */}
        <View>
          <Text style={s.sectionTitle}>Theme</Text>
          <View style={s.card}>
            {themeList().map((th, i) => (
              <View key={th.id}>
                {i > 0 && <View style={s.divider} />}
                <TouchableOpacity
                  style={s.row}
                  onPress={() => { if (user) chooseTheme(user.id, th.id); }}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowLabel}>{th.name}</Text>
                  </View>
                  {/* Palette preview: bg / surface / primary / accent */}
                  {[th.colors.background, th.colors.surface, th.colors.primary, th.colors.accent].map((c, j) => (
                    <View
                      key={j}
                      style={{
                        width: 18, height: 18, borderRadius: 9, backgroundColor: c,
                        borderWidth: 1, borderColor: th.colors.border, marginLeft: 4,
                      }}
                    />
                  ))}
                  <Text style={[s.rowSub, { marginLeft: t.spacing.md, width: 18 }]}>
                    {activeThemeId === th.id ? '✓' : ''}
                  </Text>
                </TouchableOpacity>
              </View>
            ))}
            <View style={s.divider} />
            <View style={s.infoBlock}>
              <Text style={s.rowSub}>Synced to your account — follows you across devices.</Text>
            </View>
          </View>
        </View>

        {/* ── Org default theme (admins; app_config, synced) ────────────── */}
        {isAdmin && (
          <View>
            <Text style={s.sectionTitle}>Org default theme</Text>
            <View style={s.card}>
              {themeList().map((th, i) => (
                <View key={th.id}>
                  {i > 0 && <View style={s.divider} />}
                  <TouchableOpacity
                    style={s.row}
                    onPress={() => {
                      try { setOrgDefaultTheme(th.id, user?.id ?? null); setOrgThemeId(th.id); }
                      catch { /* blocked write — ignore */ }
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={s.rowLabel}>{th.name}</Text>
                    </View>
                    {[th.colors.background, th.colors.surface, th.colors.primary, th.colors.accent].map((c, j) => (
                      <View
                        key={j}
                        style={{
                          width: 18, height: 18, borderRadius: 9, backgroundColor: c,
                          borderWidth: 1, borderColor: th.colors.border, marginLeft: 4,
                        }}
                      />
                    ))}
                    <Text style={[s.rowSub, { marginLeft: t.spacing.md, width: 18 }]}>
                      {orgThemeId === th.id ? '✓' : ''}
                    </Text>
                  </TouchableOpacity>
                </View>
              ))}
              <View style={s.divider} />
              <View style={s.infoBlock}>
                <Text style={s.rowSub}>
                  Applies to the sign-in screen, new installs, and everyone who hasn't picked their own theme. Personal picks above always win.
                </Text>
              </View>
            </View>
          </View>
        )}

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
              {isApex && (
                <>
                  <View style={s.divider} />
                  <View style={s.row}>
                    <View style={{ flex: 1 }}>
                      <Text style={s.rowLabel}>🎭 Demo accounts</Text>
                      <Text style={s.rowSub}>
                        When off, demo logins are hidden from the login screen and can't enroll new devices.
                      </Text>
                    </View>
                    <Switch
                      value={demoOn === true}
                      disabled={demoOn === null}
                      onValueChange={(v) => { void handleToggleDemoMode(v); }}
                    />
                  </View>
                </>
              )}
              <View style={s.divider} />
              <View style={{ paddingHorizontal: t.spacing.base, paddingTop: t.spacing.base }}>
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
              <View style={{ paddingHorizontal: t.spacing.base, paddingTop: t.spacing.base }}>
                <Text style={s.rowLabel}>Main storage area</Text>
                <Text style={s.rowSub}>New stock (e.g. Quick Add) defaults to this location. Pick a shelf if the area has them.</Text>
                <View style={{ marginTop: t.spacing.sm }}>
                  <SearchablePicker
                    placeholder="Search locations…"
                    options={locationOptions}
                    value={storageLoc}
                    onSelect={handleStorageLocationSelect}
                  />
                  {storageLocHasShelves && (
                    <View style={{ marginTop: t.spacing.sm }}>
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
                  <Text style={s.rowSub}>Edit job, team, location & equipment types (label + icon), synced to all devices.</Text>
                </View>
                <Text style={s.rowSub}>›</Text>
              </TouchableOpacity>
              <View style={s.divider} />
              <TouchableOpacity
                style={s.row}
                onPress={() => router.push('/(app)/(admin)/analytics')}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>📊 Analytics</Text>
                  <Text style={s.rowSub}>Usage insights — top screens, actions, errors & devices (live, admin only).</Text>
                </View>
                <Text style={s.rowSub}>›</Text>
              </TouchableOpacity>
              <View style={s.divider} />
              <TouchableOpacity
                style={s.row}
                onPress={() => router.push('/(app)/(admin)/label-templates')}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>🏷️ Label Designer</Text>
                  <Text style={s.rowSub}>Design custom label layouts (drag fields on a canvas), synced to all devices.</Text>
                </View>
                <Text style={s.rowSub}>›</Text>
              </TouchableOpacity>
              <View style={s.divider} />
              <TouchableOpacity
                style={s.row}
                onPress={() => router.push('/(app)/(admin)/dashboards')}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>🧩 Dashboards</Text>
                  <Text style={s.rowSub}>Build role/user home-screen layouts, synced to all devices.</Text>
                </View>
                <Text style={s.rowSub}>›</Text>
              </TouchableOpacity>
            </View>
            <QrSigningSection />
          </View>
        )}

        {/* ── Broadcast (send_notifications holders — may not be full admins) ── */}
        {canBroadcast && (
          <View style={s.card}>
            <TouchableOpacity
              style={s.row}
              onPress={() => router.push('/(app)/(admin)/broadcast')}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.rowLabel}>📣 Send Broadcast</Text>
                <Text style={s.rowSub}>Compose a notification to roles, teams, or everyone.</Text>
              </View>
              <Text style={s.rowSub}>›</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* ── API Audit (view_audit_log holders — may not be full admins) ── */}
        {canViewAudit && (
          <View style={s.card}>
            <TouchableOpacity
              style={s.row}
              onPress={() => router.push('/(app)/(admin)/audit-log')}
            >
              <View style={{ flex: 1 }}>
                <Text style={s.rowLabel}>🛡️ API Audit</Text>
                <Text style={s.rowSub}>Who called the API, when, and whether it succeeded (live).</Text>
              </View>
              <Text style={s.rowSub}>›</Text>
            </TouchableOpacity>
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
              <View style={{ paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.base, gap: t.spacing.sm }}>
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
              <View style={{ paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.base, gap: t.spacing.sm }}>
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

        {/* ── Notification Routing (admin only — synced app_config) ────── */}
        {isAdmin && (
          <View>
            <Text style={s.sectionTitle}>Notification Routing</Text>
            <View style={s.card}>
              <TouchableOpacity
                style={s.row}
                onPress={() => router.push('/(app)/(admin)/notification-routing')}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>🔔 Notification Routing</Text>
                  <Text style={s.rowSub}>Choose who gets notified for each event</Text>
                </View>
                <Text style={s.rowSub}>›</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── On-Call Settings (admin only — synced app_config) ─────────── */}
        {isAdmin && (
          <View>
            <Text style={s.sectionTitle}>On-Call</Text>
            <View style={s.card}>
              <TouchableOpacity
                style={s.row}
                onPress={() => router.push('/(app)/(admin)/on-call-settings')}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>📅 On-Call Settings</Text>
                  <Text style={s.rowSub}>Week boundary and crew rotation order</Text>
                </View>
                <Text style={s.rowSub}>›</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Approvals (admin only — synced app_config) ────────────────── */}
        {isAdmin && (
          <View>
            <Text style={s.sectionTitle}>Approvals</Text>
            <View style={s.card}>
              <View style={{ paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.base, gap: t.spacing.sm }}>
                <Text style={s.rowLabel}>Require approval for movements ≥ (blank = off)</Text>
                <Text style={s.rowSub}>Checkouts or transfers of this quantity or more auto-create an approval request for review.</Text>
                <AppInput
                  value={thresholdInput}
                  onChangeText={setThresholdInput}
                  onEndEditing={commitApprovalThreshold}
                  keyboardType="number-pad"
                  placeholder="Off"
                  style={{ width: 100 }}
                />
              </View>
            </View>
          </View>
        )}

        {/* ── Hidden Fields (admin only — synced via app_config) ───────── */}
        {isAdmin && (
          <View>
            <Text style={s.sectionTitle}>Hidden Fields</Text>
            <View style={s.card}>
              <TouchableOpacity
                style={s.row}
                onPress={() => router.push('/(app)/(admin)/hidden-fields')}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>🙈 Hidden Fields</Text>
                  <Text style={s.rowSub}>Hide optional fields for all users on all devices.</Text>
                </View>
                <Text style={s.rowSub}>›</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Gas Receipt Payers (#168 — synced via app_config) ────────── */}
        {isAdmin && (
          <View>
            <Text style={s.sectionTitle}>Gas Receipts</Text>
            <View style={s.card}>
              <TouchableOpacity
                style={s.row}
                onPress={() => router.push('/(app)/(admin)/gas-receipt-payers')}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>⛽ Gas Receipt Payers</Text>
                  <Text style={s.rowSub}>Who receipts can be charged to.</Text>
                </View>
                <Text style={s.rowSub}>›</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* ── Unit Access Defaults (admin only — synced via app_config) ── */}
        {isAdmin && (
          <View>
            <Text style={s.sectionTitle}>Unit Access</Text>
            <View style={s.card}>
              <TouchableOpacity
                style={s.row}
                onPress={() => router.push('/(app)/(admin)/unit-access-defaults')}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>🔑 Unit Access Defaults</Text>
                  <Text style={s.rowSub}>What a new vehicle/locker grant allows, per role.</Text>
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
                onPress={() => router.push('/(app)/(quickadd)')}
              >
                <Text style={s.rowLabel}>⚡ Quick Add</Text>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.row} onPress={handleGenerateSampleData}>
                <Text style={s.rowLabel}>🧪 Generate Sample Data</Text>
                <Text style={s.rowSub}>{user?.is_test ? 'Sandbox' : 'Test acct only'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

      </FormScreen>
    </>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const makeStyles = (t: Theme) => StyleSheet.create({
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
  rowSub: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, marginTop: 2 },
  chevron: { fontSize: 18, color: t.colors.textMuted, fontWeight: '300' },
  muted: { color: t.colors.textMuted },
  danger: { color: t.colors.danger },

  divider: { height: 1, backgroundColor: t.colors.border, marginHorizontal: t.spacing.base },

  infoBlock: { paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.md, gap: 4 },

  // Idle-timeout chip selector
  idleRow: {
    flexDirection: 'row',
    padding: t.spacing.md,
    gap: 8,
  },
  idleChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: t.radii.sm,
    borderWidth: 1,
    borderColor: t.colors.textDisabled,
    backgroundColor: t.colors.background,
    alignItems: 'center',
  },
  idleChipActive: {
    backgroundColor: t.colors.brand,
    borderColor: t.colors.brand,
  },
  idleChipText: {
    fontSize: t.typography.fontSizes.body2,
    fontWeight: '600',
    color: '#475569',
  },
  idleChipTextActive: {
    color: t.colors.onPrimary,
  },
});
