import { useState, useEffect, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import type { Theme } from '../../src/themes/types';
import { useTheme } from '../../src/hooks/useTheme';
import { useThemedStyles } from '../../src/hooks/useThemedStyles';
import { useSession } from '../../src/hooks/useSession';
import { promptBiometric } from '../../src/auth/biometric';
import {
  getSavedUserId, buildUserSession, getValidJwt, clearSession,
} from '../../src/auth/session';

export default function UnlockScreen() {
  const styles = useThemedStyles(makeStyles);
  const t = useTheme();
  const router = useRouter();
  const { setUser } = useSession();
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [name, setName] = useState<string>('');

  const attemptUnlock = useCallback(async () => {
    setBusy(true);
    setFailed(false);

    const userId = await getSavedUserId();
    if (!userId) { router.replace('/(auth)/login'); return; }

    const session = buildUserSession(userId);
    if (!session) {
      // User no longer present/active locally — force a fresh sign-in.
      await clearSession();
      router.replace('/(auth)/login');
      return;
    }
    setName(session.name);

    const ok = await promptBiometric(`Unlock as ${session.name}`);
    if (!ok) { setBusy(false); setFailed(true); return; }

    // Biometric passed — resume the session and refresh the JWT in the
    // background so sync works (no PIN re-entry, fully offline-capable).
    setUser(session);
    getValidJwt().catch(() => { /* offline is fine; sync retries later */ });
    router.replace('/(app)/(dashboard)');
  }, [router, setUser]);

  useEffect(() => { attemptUnlock(); }, [attemptUnlock]);

  async function signInAsSomeoneElse() {
    await clearSession();
    router.replace('/(auth)/login');
  }

  return (
    <View style={styles.container}>
      <Text style={styles.appName}>InventoryPro</Text>

      {busy ? (
        <>
          <ActivityIndicator size="large" color={t.colors.primary} style={styles.spinner} />
          <Text style={styles.heading}>Unlocking{name ? ` for ${name}` : ''}…</Text>
        </>
      ) : (
        <>
          <Text style={styles.lockIcon}>🔒</Text>
          <Text style={styles.heading}>
            {failed ? 'Unlock canceled' : 'Locked'}
          </Text>
          <Text style={styles.sub}>
            {name ? `Welcome back, ${name}.` : ''} Use your biometrics to get back in.
          </Text>

          <TouchableOpacity style={styles.primaryBtn} onPress={attemptUnlock}>
            <Text style={styles.primaryBtnText}>Unlock</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryBtn} onPress={signInAsSomeoneElse}>
            <Text style={styles.secondaryBtnText}>Sign in as someone else</Text>
          </TouchableOpacity>
        </>
      )}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { flex: 1, backgroundColor: t.colors.background, alignItems: 'center', justifyContent: 'center', padding: 32 },
  appName: { fontSize: 20, fontWeight: '700', color: t.colors.primaryText, marginBottom: 40 },
  spinner: { marginBottom: 24 },
  lockIcon: { fontSize: 48, marginBottom: 16 },
  heading: { fontSize: 22, fontWeight: '700', color: t.colors.brand, marginBottom: 8 },
  sub: { fontSize: 14, color: t.colors.textSecondary, textAlign: 'center', marginBottom: 36 },
  primaryBtn: {
    backgroundColor: t.colors.primary, paddingVertical: 14, paddingHorizontal: 48,
    borderRadius: 12, marginBottom: 16,
  },
  primaryBtnText: { color: t.colors.onPrimary, fontSize: 16, fontWeight: '600' },
  secondaryBtn: { paddingVertical: 10 },
  secondaryBtnText: { color: t.colors.primaryText, fontSize: 15 },
});
