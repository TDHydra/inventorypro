import type { CachedCoords } from './logCoords';

// Web variant of the foreground location cache (Metro resolves .web.ts on web).
// Uses the browser Geolocation API's watchPosition so the same appendLog
// fallback works in the Expo Web build; degrades silently where geolocation is
// unavailable (insecure context / unsupported browser / denied).

let cached: CachedCoords | null = null;
let watchId: number | null = null;

export type LocationPermission = 'unknown' | 'granted' | 'denied' | 'unavailable';

export async function primeLocation(): Promise<void> {
  if (watchId != null) return;
  if (typeof navigator === 'undefined' || !navigator.geolocation) return;
  try {
    watchId = navigator.geolocation.watchPosition(
      (pos) => {
        cached = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null };
      },
      () => { /* denied / unavailable / timeout — silent degrade, cache stays null */ },
      { enableHighAccuracy: false, maximumAge: 30_000 },
    );
  } catch { /* watchPosition unsupported — leave cache null */ }
}

export function stopLocation(): void {
  if (watchId != null && typeof navigator !== 'undefined' && navigator.geolocation) {
    try { navigator.geolocation.clearWatch(watchId); } catch { /* already cleared */ }
  }
  watchId = null;
  cached = null;
}

export function getCachedPosition(): CachedCoords | null {
  return cached;
}

export function locationPermissionState(): LocationPermission {
  return 'unknown';
}
