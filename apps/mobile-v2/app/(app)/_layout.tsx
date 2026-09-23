import { useEffect } from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import type { Theme } from '@invenpro/ui';
import { useTheme, useThemedStyles, OfflineBanner } from '@invenpro/ui';
import { useSession } from '../../src/hooks/useSession';
import { usePermission } from '../../src/hooks/usePermission';
import { setMaintenanceRole } from '../../src/db/maintenance';
import { NotificationBell } from '../../src/components/NotificationBell';
import { ChatBell } from '../../src/components/ChatBell';
import { QuickPhotoFlow, openQuickPhoto } from '../../src/components/quickphoto/QuickPhotoFlow';

// Minimal Phase 2 shell. NotificationBell restored Station B4; ChatBell
// restored Station D1; header quick-photo button + QuickPhotoFlow host
// restored Station D2. The old app's remaining header accessories (sync
// indicator sheet) and the idle logout/re-auth gates return with their
// surfaces in Wave D.
export default function AppLayout() {
  const { user, realUser, logout } = useSession();
  const canUploadMedia = usePermission('upload_media');
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
              {canUploadMedia && (
                <TouchableOpacity style={styles.switchBtn} onPress={() => openQuickPhoto()} hitSlop={8}>
                  <Text style={styles.switchText}>📷</Text>
                </TouchableOpacity>
              )}
              <ChatBell />
              <NotificationBell />
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
      <QuickPhotoFlow />
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
