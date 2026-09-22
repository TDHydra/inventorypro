import { useState, useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { useSession } from './useSession';
import { ROLE_TIER } from '../constants/roles';
import { isMaintenanceActive } from '../db/maintenance';

/**
 * Reactive view of maintenance state for UI. `active` = flag is ON;
 * `locked` = active AND the current user is not tier-4 (so they're read-only).
 * Re-reads on screen focus (covers post-sync-pull changes for v1).
 */
export function useMaintenanceMode(): { active: boolean; locked: boolean } {
  const { user } = useSession();
  const [active, setActive] = useState<boolean>(() => isMaintenanceActive());

  useFocusEffect(
    useCallback(() => {
      setActive(isMaintenanceActive());
    }, []),
  );

  const isTier4 = user != null && ROLE_TIER[user.role] === 4;
  return { active, locked: active && !isTier4 };
}
