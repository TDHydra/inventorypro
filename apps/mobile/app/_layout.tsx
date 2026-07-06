import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { initDb } from '../src/db/schema';
import { SessionContext, SessionContextValue } from '../src/hooks/useSession';
import { UserSession } from '../src/auth/permissions';
import { clearSession } from '../src/auth/session';
import { startSyncEngine, stopSyncEngine } from '../src/sync/engine';
import { loadClassConfigCache } from '../src/constants/units';
import { loadRolePermissionCache } from '../src/auth/permissions';
import { loadDashboardCache } from '../src/dashboard/store';
import { getAppSetting } from '../src/db/appSettings';
// Importing localAlerts also registers the foreground notification handler at
// module load (setNotificationHandler).
import { initNotifications, ensureNotificationPermission } from '../src/notifications/localAlerts';
import { AlertHost } from '../src/lib/themedAlert';
import { useScreenTracking } from '../src/telemetry/useScreenTracking';
import { installGlobalErrorTracking, TelemetryErrorBoundary } from '../src/telemetry/capture';
import { useNotificationObservers } from '../src/push/handlers';
import { unregisterPush } from '../src/push/register';

export default function RootLayout() {
  const [dbReady, setDbReady] = useState(false);
  const [user, setUser] = useState<UserSession | null>(null);

  // Telemetry screen-view tracking + push tap/deep-link observers. Hooks are
  // called unconditionally (before any early return) per the rules of hooks.
  useScreenTracking();
  useNotificationObservers();

  useEffect(() => {
    installGlobalErrorTracking();
    initDb()
      .then(() => {
        setDbReady(true);
        loadClassConfigCache();
        loadRolePermissionCache();
        loadDashboardCache();
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

  const logout = async () => {
    // Unregister the push token first — the /push/unregister route is authed,
    // so it must run BEFORE clearSession() deletes the JWT. Best-effort.
    await unregisterPush();
    await clearSession();
    setUser(null);
  };

  const sessionValue: SessionContextValue = { user, setUser, logout };

  if (!dbReady) return null;

  return (
    <SessionContext.Provider value={sessionValue}>
      <TelemetryErrorBoundary>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }} />
        <AlertHost />
      </TelemetryErrorBoundary>
    </SessionContext.Provider>
  );
}
