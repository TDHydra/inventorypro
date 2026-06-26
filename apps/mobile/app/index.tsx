import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { hasStoredSession } from '../src/auth/session';
import { getAllActiveUsers } from '../src/db/queries/users';

export default function Index() {
  const router = useRouter();

  useEffect(() => {
    async function route() {
      const users = getAllActiveUsers();

      // No users in local DB → first launch, need to download
      if (users.length === 0) {
        router.replace('/(auth)/first-launch');
        return;
      }

      // Returning user with a stored session → biometric unlock (no PIN re-entry).
      // The unlock screen restores the session and refreshes the JWT.
      if (await hasStoredSession()) {
        router.replace('/(auth)/unlock');
        return;
      }

      // Has local data but no stored session → first-time online sign-in.
      router.replace('/(auth)/login');
    }

    route();
  }, []);

  return null;
}
