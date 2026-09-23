import { useCallback, useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Switch, StyleSheet, ScrollView } from 'react-native';
import { Stack, useRouter, useFocusEffect } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles, Alert, AppInput } from '@invenpro/ui';
import {
  useDbQuery, getAppSetting, setAppSetting, getAppConfig, setAppConfigLocal, appendOutbox,
} from '@invenpro/core';
import { useSession } from '../../../src/hooks/useSession';
import { usePermission } from '../../../src/hooks/usePermission';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import {
  getQuietHours, setQuietHours,
  NOTIFICATION_CATEGORIES, getNotificationPrefs, setNotificationCategoryPref,
  type NotificationCategory,
} from '../../../src/db/userPrefs';
import { ensureNotificationPermission } from '../../../src/notifications/localAlerts';
import { NotificationRoutingEditor } from '../../../src/components/NotificationRoutingEditor';

// Station D3: Settings → Notifications. Absorbs three old-app surfaces:
// the settings screen's device toggle + quiet hours, the "My Notifications"
// per-category sheet (#245 — inline switches here instead of a sheet), and
// the standalone notification-routing admin screen (rendered inline).

// ── Quiet hours (#242) ──────────────────────────────────────────────────────
// Fixed presets rather than a free-form time picker (reuse-first: no picker
// component exists). Hours are LOCAL wall-clock, converted to the
// UTC-minutes-since-midnight the server understands at press time.
const QUIET_HOURS_PRESETS: { label: string; startHour: number; endHour: number }[] = [
  { label: '9 PM – 7 AM', startHour: 21, endHour: 7 },
  { label: '10 PM – 6 AM', startHour: 22, endHour: 6 },
  { label: '11 PM – 6 AM', startHour: 23, endHour: 6 },
];

// Converts a LOCAL wall-clock hour (0-23) to UTC-minutes-since-midnight using
// the device's CURRENT UTC offset. Computed at press time, not stored — a
// later DST shift or travel leaves the old offset baked into the saved window
// until the user reselects a preset here (no timezone column in the schema).
function localHourToUtcMin(hour: number): number {
  const offsetMin = new Date().getTimezoneOffset();
  return (((hour * 60 + offsetMin) % 1440) + 1440) % 1440;
}

// Friendly labels for the 7 server-driven push categories (#245). low_stock
// and server_errors are deliberately absent — production/inventory-health
// alerts an individual can't silence for themselves alone.
const CATEGORY_LABELS: Record<NotificationCategory, { label: string; sub: string }> = {
  assignment: { label: 'Assignments', sub: 'When you’re assigned a repair.' },
  chat: { label: 'Chat messages', sub: 'New messages in your conversations.' },
  schedule: { label: 'Schedule changes', sub: 'When your shift or schedule changes.' },
  approvals: { label: 'Approval requests', sub: 'Requests waiting on your decision, or decisions on yours.' },
  on_call: { label: 'On-call coverage', sub: 'Coverage changes on the on-call bench.' },
  checkout_idle: { label: 'Checkout idle reminders', sub: 'A team checkout that’s been sitting open.' },
  broadcast: { label: 'Announcements', sub: 'Company-wide broadcasts from admins.' },
};

// ── Notification trigger config keys (app_config, admin-editable) ──────────
const NOTIFY_ENABLED_KEY = 'notify_enabled';
const NOTIFY_POLL_MIN_KEY = 'notify_poll_interval_min';
const NOTIFY_IDLE_MIN_KEY = 'notify_checkout_idle_min';

/**
 * Writes a synced `app_config` value: locally + through the outbox so it
 * reaches the server (INSERT is the outbox's full-row upsert op; the server
 * applies ON CONFLICT (key) DO UPDATE).
 */
function setAppConfigSynced(key: string, value: string): void {
  setAppConfigLocal(key, value);
  appendOutbox('INSERT', 'app_config', {
    key,
    value,
    updated_at: new Date().toISOString(),
  });
}

export default function NotificationSettings() {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();
  const { user } = useSession();
  const isAdmin = usePermission('system_settings');
  const refreshKey = useFocusOrDataRefresh();

  // Device toggle + quiet hours are local state (app_settings writes don't
  // bump the data version; user_prefs writes do, but the same seeded-state
  // shape keeps taps instant either way), re-seeded on focus/data ticks.
  // Default ON when the pref is unset.
  const [notifEnabled, setNotifEnabled] = useState<boolean>(() => getAppSetting('notifications_enabled') !== 'false');
  const [quietHours, setQuietHoursState] = useState<{ start: number; end: number } | null>(() => (user ? getQuietHours(user.id) : null));
  const [notifyTriggersOn, setNotifyTriggersOn] = useState<boolean>(() => getAppConfig(NOTIFY_ENABLED_KEY) !== '0');
  const [pollMinInput, setPollMinInput] = useState<string>(() => getAppConfig(NOTIFY_POLL_MIN_KEY) ?? '5');
  const [idleMinInput, setIdleMinInput] = useState<string>(() => getAppConfig(NOTIFY_IDLE_MIN_KEY) ?? '15');

  useEffect(() => {
    setNotifEnabled(getAppSetting('notifications_enabled') !== 'false');
    setQuietHoursState(user ? getQuietHours(user.id) : null);
  }, [user, refreshKey]);

  // The trigger inputs re-seed on FOCUS only, so a background pull never
  // clobbers in-progress typing (old-screen precedent).
  useFocusEffect(
    useCallback(() => {
      setNotifyTriggersOn(getAppConfig(NOTIFY_ENABLED_KEY) !== '0');
      setPollMinInput(getAppConfig(NOTIFY_POLL_MIN_KEY) ?? '5');
      setIdleMinInput(getAppConfig(NOTIFY_IDLE_MIN_KEY) ?? '15');
    }, []),
  );

  // Per-category push mutes (#245, synced user_prefs — writes bump, so this
  // stays a plain reactive read).
  const prefs = useDbQuery(
    () => (user ? getNotificationPrefs(user.id) : {}),
    [user?.id],
    ['user_prefs'],
  );

  const handleToggleNotifications = async (enabled: boolean) => {
    try {
      setAppSetting('notifications_enabled', enabled ? 'true' : 'false');
      setNotifEnabled(enabled);
      // Turning ON: make sure we actually hold OS permission, otherwise
      // nothing will surface. If denied, point the user at the OS settings.
      if (enabled) {
        const granted = await ensureNotificationPermission();
        if (!granted) {
          Alert.alert(
            'Notifications are off',
            'To get low-stock and expiry alerts, enable notifications for InventoryPro in your device Settings.',
          );
        }
      }
    } catch { /* blocked write — ignore */ }
  };

  // Selecting a preset (or the same one again) toggles it off; a different
  // preset overwrites the window outright. Converts the preset's LOCAL hours
  // to UTC-minutes at press time and persists via the column-scoped userPrefs
  // upsert.
  const handleSetQuietHours = (preset: { startHour: number; endHour: number } | null) => {
    try {
      if (!user) return;
      if (!preset) {
        setQuietHours(user.id, null, null);
        setQuietHoursState(null);
        return;
      }
      const start = localHourToUtcMin(preset.startHour);
      const end = localHourToUtcMin(preset.endHour);
      setQuietHours(user.id, start, end);
      setQuietHoursState({ start, end });
    } catch { /* blocked write — ignore */ }
  };

  const handleToggleNotifyTriggers = (enabled: boolean) => {
    try {
      setAppConfigSynced(NOTIFY_ENABLED_KEY, enabled ? '1' : '0');
      setNotifyTriggersOn(enabled);
    } catch { /* blocked write — ignore */ }
  };

  // Commits a numeric app_config field on blur: integer in [1, 1440] minutes,
  // reverting the field to its last-known-good value on invalid input. The
  // upper bound mirrors the server clamp (getNotifyConfig).
  const commitNotifyIntConfig = (
    key: string,
    text: string,
    fallback: string,
    setInput: (v: string) => void,
  ) => {
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1440) {
      setInput(fallback);
      return;
    }
    const value = String(n);
    try { setAppConfigSynced(key, value); } catch { /* blocked write — ignore */ }
    setInput(value);
  };

  if (!user) return null;

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <Stack.Screen options={{ title: 'Notifications' }} />

      {/* ── This device ─────────────────────────────────────────────── */}
      <View>
        <Text style={s.sectionTitle}>This device</Text>
        <View style={s.card}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.rowLabel}>Stock & expiry alerts</Text>
              <Text style={s.rowSub}>
                Get a notification when an item runs low or a temporary employee&apos;s access is about to expire.
              </Text>
            </View>
            <Switch value={notifEnabled} onValueChange={(v) => { void handleToggleNotifications(v); }} />
          </View>
        </View>
      </View>

      {/* ── Quiet hours (per user, synced) ──────────────────────────── */}
      <View>
        <Text style={s.sectionTitle}>Quiet hours</Text>
        <View style={s.card}>
          <View style={s.infoBlock}>
            <Text style={s.rowSub}>
              Pause push notifications (including chat) during this window. Your in-app inbox still fills up as normal.
            </Text>
          </View>
          <View style={s.chipRow}>
            {[{ label: 'Off', startHour: null, endHour: null } as { label: string; startHour: number | null; endHour: number | null }, ...QUIET_HOURS_PRESETS].map(opt => {
              const active = opt.startHour == null
                ? quietHours == null
                : quietHours != null
                  && quietHours.start === localHourToUtcMin(opt.startHour)
                  && quietHours.end === localHourToUtcMin(opt.endHour as number);
              return (
                <TouchableOpacity
                  key={opt.label}
                  style={[s.chip, active && s.chipActive]}
                  onPress={() => handleSetQuietHours(opt.startHour == null ? null : { startHour: opt.startHour, endHour: opt.endHour as number })}
                >
                  <Text style={[s.chipText, active && s.chipTextActive]}>{opt.label}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </View>

      {/* ── My categories (#245, per user, synced) ──────────────────── */}
      <View>
        <Text style={s.sectionTitle}>What buzzes my phone</Text>
        <View style={s.card}>
          <View style={s.infoBlock}>
            <Text style={s.rowSub}>
              Turn off push nudges for a category — it still shows up in your notification inbox, it just won&apos;t buzz your phone.
            </Text>
          </View>
          {NOTIFICATION_CATEGORIES.map(category => {
            const { label, sub } = CATEGORY_LABELS[category];
            const enabled = prefs?.[category] !== false;
            return (
              <View key={category}>
                <View style={s.divider} />
                <View style={s.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.rowLabel}>{label}</Text>
                    <Text style={s.rowSub}>{sub}</Text>
                  </View>
                  <Switch
                    value={enabled}
                    onValueChange={(v) => setNotificationCategoryPref(user.id, category, v)}
                  />
                </View>
              </View>
            );
          })}
        </View>
      </View>

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
              <Switch value={notifyTriggersOn} onValueChange={handleToggleNotifyTriggers} />
            </View>
            <View style={s.divider} />
            <View style={s.inputBlock}>
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
            <View style={s.inputBlock}>
              <Text style={s.rowLabel}>Checkout idle timeout (minutes)</Text>
              <Text style={s.rowSub}>How long after a user&apos;s last checkout before their manager is notified.</Text>
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
          <Text style={s.sectionTitle}>Who gets notified</Text>
          <View style={[s.card, s.routingCard]}>
            <NotificationRoutingEditor onSave={setAppConfigSynced} />
          </View>
        </View>
      )}

      {/* ── On-Call Settings (admin only) ─────────────────────────────── */}
      {isAdmin && (
        <View>
          <Text style={s.sectionTitle}>On-Call</Text>
          <View style={s.card}>
            <TouchableOpacity style={s.row} onPress={() => router.push('/(app)/oncall/settings')}>
              <View style={{ flex: 1 }}>
                <Text style={s.rowLabel}>📅 On-Call Settings</Text>
                <Text style={s.rowSub}>Week boundary and crew rotation order.</Text>
              </View>
              <Text style={s.chevron}>›</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </ScrollView>
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
  rowSub: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, marginTop: 2 },
  chevron: { fontSize: 18, color: t.colors.textMuted, fontWeight: '300' },
  divider: { height: 1, backgroundColor: t.colors.border, marginHorizontal: t.spacing.base },
  infoBlock: { paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.md, gap: 4 },
  inputBlock: { paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.base, gap: t.spacing.sm },
  routingCard: { padding: t.spacing.base },

  chipRow: { flexDirection: 'row', padding: t.spacing.md, gap: 8 },
  chip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: t.radii.sm,
    borderWidth: 1,
    borderColor: t.colors.textDisabled,
    backgroundColor: t.colors.background,
    alignItems: 'center',
  },
  chipActive: { backgroundColor: t.colors.brand, borderColor: t.colors.brand },
  chipText: { fontSize: t.typography.fontSizes.body2, fontWeight: '600', color: '#475569' },
  chipTextActive: { color: t.colors.onPrimary },
});
