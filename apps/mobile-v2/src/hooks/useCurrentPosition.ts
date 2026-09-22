import { useState, useCallback } from 'react';
import * as Location from 'expo-location';

export type PositionStatus = 'idle' | 'loading' | 'granted' | 'denied' | 'unavailable';
export interface Coords { latitude: number; longitude: number; accuracy: number | null }

export function useCurrentPosition() {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [status, setStatus] = useState<PositionStatus>('idle');

  const request = useCallback(async () => {
    setStatus('loading');
    try {
      const { status: perm } = await Location.requestForegroundPermissionsAsync();
      if (perm !== 'granted') { setStatus('denied'); setCoords(null); return; }
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      setCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null });
      setStatus('granted');
    } catch {
      setStatus('unavailable'); setCoords(null);   // no hardware / timeout → silent degrade
    }
  }, []);

  return { coords, status, request };
}
