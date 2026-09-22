// Pure coordinate-resolution for the logging layer — deliberately free of any
// expo-location / navigator import so it can be unit-tested in plain Node and
// pulled into `appendLog` without dragging native modules into a test process.

export interface CachedCoords {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

export interface LogCoords {
  latitude: number | null;
  longitude: number | null;
  location_accuracy: number | null;
}

/**
 * Decide the coords a log row is stamped with. Precedence:
 *   1. what the caller explicitly passed (a coord-aware flow like move-confirm),
 *   2. else the best-effort cached foreground fix,
 *   3. else null.
 * A null `cached` (permission denied, no fix yet, or a demo/test session the
 * caller suppresses) simply degrades to the explicit-or-null path — location is
 * never allowed to block a log write.
 */
export function resolveLogCoords(
  entry: { latitude?: number | null; longitude?: number | null; location_accuracy?: number | null },
  cached: CachedCoords | null,
): LogCoords {
  return {
    latitude: entry.latitude ?? cached?.latitude ?? null,
    longitude: entry.longitude ?? cached?.longitude ?? null,
    location_accuracy: entry.location_accuracy ?? cached?.accuracy ?? null,
  };
}
