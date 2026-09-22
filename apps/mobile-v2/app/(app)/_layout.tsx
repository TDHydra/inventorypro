import { useEffect } from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useTheme, useThemedStyles, OfflineBanner } from '@invenpro/ui';
import { useSession } from '../../src/hooks/useSession';
import { setMaintenanceRole } from '../../src/db/maintenance';

// Minimal Phase 2 shell. The old app's header accessories (chat/notification
// bells, quick photo, sync indicator sheet) and the idle logout/re-auth gates
// return with their surfaces in Waves B–D.
export default function AppLayout() {
  const { user, realUser, logout } = useSession();
  const router = useRouter();
  const t = useTheme();
  const styles = useThemedStyles(makeStyles);

  // Guard — redirect to login if no session
  useEffect(() => {
    if (!user) {
      router.replace('/(auth)/login');
    }
  }, [user]);

  // Keep the write-layer exempt flag in sync with the REAL session user —
  // never the effective (possibly previewed) user, so a preview into a
  // lower-tier role can never grant itself the tier-4 maintenance exemption.
  useEffect(() => {
    setMaintenanceRole(realUser?.role ?? null);
  }, [realUser]);

  if (!user) return null;

  return (
    <View style={{ flex: 1 }}>
      {/* Offline strip — renders nothing while connected. */}
      <OfflineBanner />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.colors.headerBg },
          headerTintColor: t.colors.headerTint,
          headerTitleStyle: { fontWeight: t.typography.weights.bold, fontFamily: t.typography.fontFamily.bold },
          headerRight: () => (
            <View style={styles.headerRight}>
              <TouchableOpacity
                style={styles.switchBtn}
                onPress={() => router.push('/(auth)/login')}
              >
                <Text style={styles.switchText}>Switch</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.switchBtn} onPress={() => void logout()}>
                <Text style={styles.switchText}>Sign out</Text>
              </TouchableOpacity>
            </View>
          ),
        }}
      />
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12, marginRight: 4 },
  switchBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  switchText: { color: t.colors.headerTint, fontSize: 13, fontWeight: t.typography.weights.semibold },
});
