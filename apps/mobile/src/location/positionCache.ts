import * as Location from 'expo-location';
import type { CachedCoords } from './logCoords';

// A module-level, best-effort foreground location cache the logging layer reads
// SYNCHRONOUSLY (see appendLog). This is what makes location "built into
// logging" — prime it once at login and every subsequent action auto-stamps
// with the latest fix, with zero per-call-site code. WHEN-IN-USE only: no
// background tracking, so no extra battery drain or Play-review disclosure.

let cached: CachedCoords | null = null;
let sub: Location.LocationSubscription | null = null;
let priming = false;

export type LocationPermission = 'unknown' | 'granted' | 'denied' | 'unavailable';
let permission: LocationPermission = 'unknown';

/**
 * Start caching the foreground position. Idempotent and never throws — safe to
 * fire-and-forget on every login. Requests when-in-use permission, seeds one
 * immediate fix so the very next action can stamp, then keeps a low-frequency
 * watch. If permission is denied or there's no hardware, it silently degrades
 * (the cache stays null and log rows are written without coords).
 */
export async function primeLocation(): Promise<void> {
  if (sub || priming) return;
  priming = true;
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') { permission = 'denied'; return; }
    permission = 'granted';
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      cached = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null };
    } catch { /* seed fix failed (timeout/no fix yet) — the watch will fill it in */ }
    sub = await Location.watchPositionAsync(
      // Balanced accuracy + a coarse cadence: enough to know "where an action
      // happened" without polling GPS aggressively.
      { accuracy: Location.Accuracy.Balanced, timeInterval: 30_000, distanceInterval: 25 },
      (pos) => {
        cached = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null };
      },
    );
  } catch {
    permission = 'unavailable';   // no hardware / unexpected — silent degrade
  } finally {
    priming = false;
  }
}

/** Stop caching and forget the last fix. Call on logout / session wipe. */
export function stopLocation(): void {
  if (sub) { try { sub.remove(); } catch { /* already removed */ } sub = null; }
  cached = null;
  permission = 'unknown';
}

/** The latest foreground fix, or null. Synchronous — safe from appendLog. */
export function getCachedPosition(): CachedCoords | null {
  return cached;
}

export function locationPermissionState(): LocationPermission {
  return permission;
}
