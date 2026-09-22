import { useState, useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { getFormMode, FormMode } from '../db/formMode';

/**
 * Reactive view of the resolved form mode for UI.
 * Re-reads on screen focus so changes made in Settings (or a synced default
 * arriving) are reflected when the user returns to a form.
 * Mirrors the useMaintenanceMode pattern.
 */
export function useFormMode(): { mode: FormMode; isSimple: boolean } {
  const [mode, setMode] = useState<FormMode>(() => getFormMode());

  useFocusEffect(
    useCallback(() => {
      setMode(getFormMode());
    }, []),
  );

  return { mode, isSimple: mode === 'simple' };
}
