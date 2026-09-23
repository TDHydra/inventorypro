import { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, Switch, StyleSheet, ScrollView } from 'react-native';
import { Stack } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useThemedStyles, Alert } from '@invenpro/ui';
import { getIdleTimeoutMinutes, setIdleTimeoutMinutes } from '@invenpro/core';
import { useSession } from '../../../src/hooks/useSession';
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
import { ROLE_TIER } from '../../../src/constants/roles';
import { setMaintenanceMode, isMaintenanceActive } from '../../../src/db/maintenance';
import { getValidJwt } from '../../../src/auth/session';
import { QrSigningSection } from '../../../src/components/QrSigningSection';

// Station D3: Settings → Security. Idle auto-logout is for everyone; the
// System block (maintenance mode, demo accounts, QR label signing) is tier-4,
// with the demo-accounts kill switch apex-only — full_admin exactly, NOT
// tier-4 peers.

const IDLE_OPTIONS: { label: string; value: number }[] = [
  { label: 'Off', value: 0 },
  { label: '5 min', value: 5 },
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
];

const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';

export default function SecuritySettings() {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const refreshKey = useFocusOrDataRefresh();
  const isTier4 = user != null && ROLE_TIER[user.role] === 4;
  const isApex = user?.role === 'full_admin';

  // app_settings writes don't bump the data version — seeded state updated in
  // the handlers, re-seeded on focus/data ticks (settings-split convention).
  const [idleMinutes, setIdleMinutes] = useState<number>(() => getIdleTimeoutMinutes());
  const [maintOn, setMaintOn] = useState<boolean>(() => isMaintenanceActive());
  // Demo accounts master switch (server-side, live): null until the GET
  // resolves — the switch stays disabled while offline or unauthorized.
  const [demoOn, setDemoOn] = useState<boolean | null>(null);

  useEffect(() => {
    setIdleMinutes(getIdleTimeoutMinutes());
    setMaintOn(isMaintenanceActive());
  }, [refreshKey]);

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

  const handleSetIdle = (mins: number) => {
    try {
      setIdleTimeoutMinutes(mins);
      setIdleMinutes(mins);
    } catch { /* blocked write — ignore */ }
  };

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
            : 'The server rejected the change. Please try again.',
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

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      <Stack.Screen options={{ title: 'Security' }} />

      {/* ── Idle auto-logout (everyone) ─────────────────────────────── */}
      <View>
        <Text style={s.sectionTitle}>Idle Auto-logout</Text>
        <View style={s.card}>
          <View style={s.chipRow}>
            {IDLE_OPTIONS.map(opt => (
              <TouchableOpacity
                key={opt.value}
                style={[s.chip, idleMinutes === opt.value && s.chipActive]}
                onPress={() => handleSetIdle(opt.value)}
              >
                <Text style={[s.chipText, idleMinutes === opt.value && s.chipTextActive]}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={s.divider} />
          <View style={s.infoBlock}>
            <Text style={s.rowSub}>Signs you out on this device after the app sits untouched this long.</Text>
          </View>
        </View>
      </View>

      {/* ── System (tier-4 only) ────────────────────────────────────── */}
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
                      When off, demo logins are hidden from the login screen and can&apos;t enroll new devices.
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
          </View>
        </View>
      )}

      {/* ── QR label signing (tier-4 only — brings its own title/card) ── */}
      {isTier4 && <QrSigningSection />}
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
  divider: { height: 1, backgroundColor: t.colors.border, marginHorizontal: t.spacing.base },
  infoBlock: { paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.md, gap: 4 },

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
