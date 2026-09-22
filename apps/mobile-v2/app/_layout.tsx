import { useEffect, useMemo, useRef, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { useFonts } from 'expo-font';
import { Rajdhani_600SemiBold, Rajdhani_700Bold } from '@expo-google-fonts/rajdhani';
import { Nunito_400Regular, Nunito_600SemiBold, Nunito_700Bold } from '@expo-google-fonts/nunito';
import {
  startSyncEngine, stopSyncEngine,
  setSessionExpiredHandler, resetSessionExpiredNotice,
} from '@invenpro/core';
import {
  AlertHost, Alert, ConfirmSheetHost, loadThemeFromSettings, useTheme,
} from '@invenpro/ui';
import { bootCore } from '../src/boot';
import { initDb } from '../src/db/schema';
import { SessionContext, SessionContextValue, deriveEffectiveUser } from '../src/hooks/useSession';
import { UserSession, loadRolePermissionCache } from '../src/auth/permissions';
import { UserRole } from '../src/constants/roles';
import { clearSession } from '../src/auth/session';
import { setPreviewWriteBlock } from '../src/db/maintenance';
import { appSyncTriggers } from '../src/sync/triggers';
import { installConnectivityMonitor } from '../src/sync/installConnectivityMonitor';
import { setWebIdleLogoutHandler } from '../src/hooks/useWebIdleWipe';
import { ToastHost } from '../src/components/ToastHost';
import { PreviewBanner } from '../src/components/PreviewBanner';

// Wire core's injection seams before anything can touch sync/db modules.
bootCore();

export default function RootLayout() {
  const [dbReady, setDbReady] = useState(false);
  const [user, setUser] = useState<UserSession | null>(null);
  // Preview-as-role (#199): `user` is the real identity; previewRole swaps what
  // permission checks resolve. The admin-facing picker returns in Wave B, but
  // the context shape + central write block ship from day one so Wave B is a
  // screen, not a plumbing change.
  // Wave B: the Roles & Permissions screen's "Preview as…" picker (see
  // app/(app)/roles/index.tsx) writes this via setPreviewRole below.
  const [previewRole, setPreviewRole] = useState<UserRole | null>(null);
  const effectiveUser = useMemo(() => deriveEffectiveUser(user, previewRole), [user, previewRole]);
  const theme = useTheme();

  useEffect(() => {
    setPreviewWriteBlock(previewRole != null);
    return () => setPreviewWriteBlock(false);
  }, [previewRole]);

  // Previewing must never survive a real identity change.
  useEffect(() => {
    setPreviewRole(null);
  }, [user?.id]);

  useFonts({
    Rajdhani_600SemiBold, Rajdhani_700Bold,
    Nunito_400Regular, Nunito_600SemiBold, Nunito_700Bold,
  });

  useEffect(() => {
    initDb()
      .then(() => {
        // Device-cached theme before first render so login/unlock don't flash
        // the default look (per-user synced choice re-applies after login/pull).
        loadThemeFromSettings();
        setDbReady(true);
        loadRolePermissionCache();
        startSyncEngine(appSyncTriggers);
        installConnectivityMonitor();
      })
      .catch(err => console.error('[DB] Init failed:', err));

    return () => stopSyncEngine();
  }, []);

  const logout = async () => {
    await clearSession();
    setUser(null);
  };

  // Web idle auto-wipe drives an immediate redirect to login via this handler;
  // native never installs it. The setter is a plain module fn — native-safe.
  useEffect(() => {
    setWebIdleLogoutHandler(() => { void logout(); });
    return () => setWebIdleLogoutHandler(null);
  }, [logout]);

  // Server-side session death (refresh token expired/revoked, account
  // deactivated) runs the same full logout as the user-initiated path.
  useEffect(() => {
    setSessionExpiredHandler(() => {
      Alert.alert('Signed out', 'Your session has expired. Please log in again.');
      void logout();
    });
    return () => setSessionExpiredHandler(null);
  }, [logout]);

  // Re-arm the once-per-session expiry notice on each sign-in.
  useEffect(() => {
    if (user) resetSessionExpiredNotice();
  }, [user?.id]);

  const sessionValue: SessionContextValue = {
    user: effectiveUser,
    realUser: user,
    setUser,
    previewRole,
    setPreviewRole,
    logout,
  };

  if (!dbReady) return null;

  return (
    // SafeAreaProvider → KeyboardProvider sit ABOVE the theme-keyed <Stack> so a
    // theme switch (which remounts the Stack via its key) never tears down the
    // safe-area / keyboard native context.
    <SafeAreaProvider>
      <KeyboardProvider>
        <SessionContext.Provider value={sessionValue}>
          <StatusBar style={theme.dark ? 'light' : 'dark'} />
          {/* Persistent, unmissable strip while a preview is active — sits
              ABOVE the theme-keyed Stack so it survives theme switches and
              renders on every screen without competing with any screen's own
              header for space. */}
          <PreviewBanner />
          {/* key remounts the tree on theme switch so memoized subtrees can't
              keep stale styles. Switching is rare; acceptable. */}
          <Stack key={theme.id} screenOptions={{ headerShown: false }} />
          <AlertHost />
          <ConfirmSheetHost />
          <ToastHost />
        </SessionContext.Provider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
