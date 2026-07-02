import { useEffect } from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { useSession } from '../../src/hooks/useSession';
import { SyncIndicator } from '../../src/components/SyncIndicator';
import { NotificationBell } from '../../src/components/NotificationBell';
import { useIdleLogout } from '../../src/hooks/useIdleLogout';
import { setMaintenanceRole } from '../../src/db/maintenance';
import { useMaintenanceMode } from '../../src/hooks/useMaintenanceMode';
import { colors } from '../../src/theme';

export default function AppLayout() {
  const { user, logout } = useSession();
  const router = useRouter();

  // Idle auto-logout — must be called before any early return (React rules)
  const { reset } = useIdleLogout(logout);
  const maint = useMaintenanceMode();

  // Guard — redirect to login if no session
  useEffect(() => {
    if (!user) {
      router.replace('/(auth)/login');
    }
  }, [user]);

  // Keep the write-layer exempt flag in sync with the current session user
  useEffect(() => {
    setMaintenanceRole(user?.role ?? null);
  }, [user]);

  if (!user) return null;

  return (
    // Wrap the Stack in a View that intercepts all touch starts to reset the
    // idle timer without consuming the event (return false keeps gestures intact)
    <View
      style={{ flex: 1 }}
      onStartShouldSetResponderCapture={() => {
        reset();
        return false;
      }}
    >
      {maint.locked && (
        <View style={styles.banLocked}>
          <Text style={styles.banLockedText}>⚠ System under maintenance — read-only</Text>
        </View>
      )}
      {maint.active && !maint.locked && (
        <View style={styles.banAdmin}>
          <Text style={styles.banAdminText}>Maintenance mode is ON — you have admin override</Text>
        </View>
      )}
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.brand },
          headerTintColor: '#fff',
          headerTitleStyle: { fontWeight: '700' },
          headerRight: () => (
            <View style={styles.headerRight}>
              <NotificationBell />
              <SyncIndicator />
              <TouchableOpacity
                style={styles.switchBtn}
                onPress={() => router.push('/(auth)/login')}
              >
                <Text style={styles.switchText}>Switch</Text>
              </TouchableOpacity>
            </View>
          ),
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12, marginRight: 4 },
  switchBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
  },
  switchText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  banLocked: { backgroundColor: colors.warning, paddingVertical: 8, paddingHorizontal: 12 },
  banLockedText: { color: '#fff', fontWeight: '700', textAlign: 'center' },
  banAdmin: { backgroundColor: colors.brand, paddingVertical: 6, paddingHorizontal: 12 },
  banAdminText: { color: '#E5E7EB', fontSize: 12, textAlign: 'center' },
});
