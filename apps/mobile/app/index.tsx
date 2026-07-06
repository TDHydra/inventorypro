import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { hasStoredSession } from '../src/auth/session';

export default function Index() {
  const router = useRouter();

  useEffect(() => {
    async function route() {
      // Returning user with a stored session → biometric unlock (no PIN re-entry).
      // The unlock screen restores the session and refreshes the JWT.
      if (await hasStoredSession()) {
        router.replace('/(auth)/unlock');
        return;
      }

      // No session → login. The login screen loads its roster from the local DB
      // when present, or fetches the public /auth/roster on a brand-new device;
      // a fresh device then runs the authenticated full download after sign-in.
      router.replace('/(auth)/login');
    }

    route();
  }, []);

  return null;
}
