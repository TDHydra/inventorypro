import { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { initDb } from '../src/db/schema';
import { SessionContext, SessionContextValue } from '../src/hooks/useSession';
import { UserSession } from '../src/auth/permissions';
import { clearSession } from '../src/auth/session';
import { startSyncEngine, stopSyncEngine } from '../src/sync/engine';

export default function RootLayout() {
  const [dbReady, setDbReady] = useState(false);
  const [user, setUser] = useState<UserSession | null>(null);

  useEffect(() => {
    initDb()
      .then(() => {
        setDbReady(true);
        startSyncEngine();
      })
      .catch(err => console.error('[DB] Init failed:', err));

    return () => stopSyncEngine();
  }, []);

  const logout = async () => {
    await clearSession();
    setUser(null);
  };

  const sessionValue: SessionContextValue = { user, setUser, logout };

  if (!dbReady) return null;

  return (
    <SessionContext.Provider value={sessionValue}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerShown: false }} />
    </SessionContext.Provider>
  );
}
