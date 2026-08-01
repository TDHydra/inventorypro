import { useEffect, useMemo, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { initDb, resetLocalDb } from '../src/db/schema';
import { SessionContext, SessionContextValue, deriveEffectiveUser } from '../src/hooks/useSession';
import { UserSession } from '../src/auth/permissions';
import { UserRole } from '../src/constants/roles';
import { setPreviewWriteBlock } from '../src/db/maintenance';
import { clearSession, getSavedUserId } from '../src/auth/session';
import { loadChatCache } from '../src/chat/store';
import { TEST_SESSION_FLAG } from '../src/auth/finishLogin';
import { setSandboxActive } from '../src/sync/sandbox';
import { stopLocation } from '../src/location/positionCache';
import { startSyncEngine, stopSyncEngine } from '../src/sync/engine';
import { loadClassConfigCache } from '../src/constants/units';
import { loadRolePermissionCache } from '../src/auth/permissions';
import { loadDashboardCache } from '../src/dashboard/store';
import { getAppSetting } from '../src/db/appSettings';
// Importing localAlerts also registers the foreground notification handler at
// module load (setNotificationHandler).
import { initNotifications, ensureNotificationPermission } from '../src/notifications/localAlerts';
import { AlertHost } from '../src/lib/themedAlert';
import { ConfirmSheetHost } from '../src/components/ui/ConfirmSheet';
import { ToastHost } from '../src/components/ToastHost';
import { loadThemeFromSettings } from '../src/themes/store';
import { useTheme } from '../src/hooks/useTheme';
import { useFonts } from 'expo-font';
import { Rajdhani_600SemiBold, Rajdhani_700Bold } from '@expo-google-fonts/rajdhani';
import { Nunito_400Regular, Nunito_600SemiBold, Nunito_700Bold } from '@expo-google-fonts/nunito';
import { useScreenTracking } from '../src/telemetry/useScreenTracking';
import { installGlobalErrorTracking, TelemetryErrorBoundary } from '../src/telemetry/capture';
import { useNotificationObservers } from '../src/push/handlers';
import { registerForPush, unregisterPush } from '../src/push/register';
import { setWebIdleLogoutHandler } from '../src/hooks/useWebIdleWipe';

export default function RootLayout() {
  const [dbReady, setDbReady] = useState(false);
  const [user, setUser] = useState<UserSession | null>(null);
  // #199 core: session preview-as-role. `user` is the real signed-in identity;
  // `previewRole` (set by the later admin-facing picker track) swaps what
  // usePermission/hasPermission/PermissionGate resolve without touching the
  // real identity. `effectiveUser` is derived via plain React state + memo —
  // no separate reactive cache — so gated UI re-renders through the normal
  // React path when previewRole changes.
  const [previewRole, setPreviewRole] = useState<UserRole | null>(null);
  const effectiveUser = useMemo(() => deriveEffectiveUser(user, previewRole), [user, previewRole]);
  const theme = useTheme();

  // A preview is a real-identity impersonation of another role's VIEW only —
  // writes must never be allowed to ride along "as" the pretend role. Central,
  // same enforcement point maintenance mode already uses (isWriteBlocked /
  // assertWritable in src/db/maintenance.ts), so every write path fails the
  // same way (MaintenanceLockedError) with a distinct message instead of
  // crashing. Reset to false on unmount as a safety net.
  useEffect(() => {
    setPreviewWriteBlock(previewRole != null);
    return () => setPreviewWriteBlock(false);
  }, [previewRole]);

  // Previewing must never survive a real identity change (logout, or
  // switching to a different account without logging out first) — otherwise
  // the NEXT signed-in user could inherit the previous user's pretend role.
  useEffect(() => {
    setPreviewRole(null);
  }, [user?.id]);

  // Theme faces (Fluid/Futuristic). Non-blocking: render proceeds before they
  // resolve — themes whose fontFamily is undefined never reference them, and
  // the themed faces only appear after load on first launch.
  useFonts({
    Rajdhani_600SemiBold, Rajdhani_700Bold,
    Nunito_400Regular, Nunito_600SemiBold, Nunito_700Bold,
  });

  // Telemetry screen-view tracking + push tap/deep-link observers. Hooks are
  // called unconditionally (before any early return) per the rules of hooks.
  useScreenTracking();
  useNotificationObservers();

  useEffect(() => {
    installGlobalErrorTracking();
    initDb()
      .then(async () => {
        // A test/demo session that was killed mid-run never reached the logout
        // wipe — its throwaway edits are still in the DB. Wipe before anything
        // reads it; the empty DB then behaves like a fresh install.
        if (getAppSetting(TEST_SESSION_FLAG) === '1') {
          console.log('[DB] stale test session detected — wiping sandbox');
          await resetLocalDb();
        }
        // Device-cached theme before first render so login/unlock don't flash
        // the default look (per-user synced choice re-applies after login/pull).
        loadThemeFromSettings();
        setDbReady(true);
        loadClassConfigCache();
        loadRolePermissionCache();
        loadDashboardCache();
        void getSavedUserId().then(id => loadChatCache(id));
        startSyncEngine();
        // Notifications: create the Android channel, then (unless the user has
        // turned the pref off) make sure we hold OS permission so post-sync
        // alert checks can actually surface.
        initNotifications();
        if (getAppSetting('notifications_enabled') !== 'false') {
          void ensureNotificationPermission();
        }
      })
      .catch(err => console.error('[DB] Init failed:', err));

    return () => stopSyncEngine();
  }, []);

  // Re-register the push token on every session start — full login AND PIN
  // unlock (both flip `user`). finishLogin's call alone isn't enough: a device
  // that stays enrolled for weeks never re-registers, so a server-side token
  // disable (Expo dead-token receipt) would otherwise be permanent.
  // registerForPush itself rate-limits via its 24h freshness window.
  useEffect(() => {
    if (user && !user.is_test) registerForPush().catch(() => {});
  }, [user?.id]);

  const logout = async () => {
    const wasTestSession = !!user?.is_test;
    // Stop the foreground location watch and forget the last fix (#33) so no
    // stale position bleeds into the next session on this device.
    stopLocation();
    // Unregister the push token first — the /push/unregister route is authed,
    // so it must run BEFORE clearSession() deletes the JWT. Best-effort.
    // (Test sessions never registered one and can't call mutating routes.)
    if (!wasTestSession) await unregisterPush();
    await clearSession();
    if (wasTestSession) {
      // Discard every sandbox edit (outbox included) and the test-session flag.
      // The empty DB makes the next login fetch the public roster and run the
      // first-launch full download — a clean slate for the next visitor.
      try {
        await resetLocalDb();
      } catch (err) {
        console.error('[DB] test-session wipe failed:', err);
      }
      setSandboxActive(false);
    }
    setUser(null);
  };

  // The web idle auto-wipe (#43) drives an immediate redirect to login by calling
  // the session logout() — register it here so the wipe flips SessionContext
  // without a hard reload. Native-safe: the setter is a plain module fn and the
  // idle wipe never installs on native. performWebIdleWipe() resets the DB itself.
  useEffect(() => {
    setWebIdleLogoutHandler(() => { void logout(); });
    return () => setWebIdleLogoutHandler(null);
  }, [logout]);

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
    // safe-area / keyboard native context. SafeAreaProvider must be outermost so
    // useSafeAreaInsets() resolves real insets everywhere below (#118).
    <SafeAreaProvider>
      <KeyboardProvider>
        <SessionContext.Provider value={sessionValue}>
          <TelemetryErrorBoundary>
            <StatusBar style={theme.dark ? 'light' : 'dark'} />
            {/* key remounts the tree on theme switch so memoized/unmigrated
                subtrees can't keep stale styles. Switching is rare; acceptable. */}
            <Stack key={theme.id} screenOptions={{ headerShown: false }} />
            <AlertHost />
            <ConfirmSheetHost />
            <ToastHost />
          </TelemetryErrorBoundary>
        </SessionContext.Provider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}
