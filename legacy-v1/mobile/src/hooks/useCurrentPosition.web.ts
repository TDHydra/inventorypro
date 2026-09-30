import { useState, useCallback } from 'react';

export type PositionStatus = 'idle' | 'loading' | 'granted' | 'denied' | 'unavailable';
export interface Coords { latitude: number; longitude: number; accuracy: number | null }

export function useCurrentPosition() {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [status, setStatus] = useState<PositionStatus>('idle');

  const request = useCallback(async () => {
    setStatus('loading');
    // No geolocation support (insecure context / unsupported browser) → silent degrade.
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('unavailable'); setCoords(null); return;
    }
    try {
      await new Promise<void>((resolve) => {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setCoords({
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy: pos.coords.accuracy ?? null,
            });
            setStatus('granted');
            resolve();
          },
          (err) => {
            // PERMISSION_DENIED === 1 → denied; anything else (position unavailable
            // / timeout / no hardware) → silent degrade, mirroring native.
            if (err.code === err.PERMISSION_DENIED) setStatus('denied');
            else setStatus('unavailable');
            setCoords(null);
            resolve();
          },
          { enableHighAccuracy: false },
        );
      });
    } catch {
      setStatus('unavailable'); setCoords(null);
    }
  }, []);

  return { coords, status, request };
}
