// Pure proximity math for the #84 vehicle-intake flow ("Add a vehicle" appears
// only when the crew flag is on AND the device is physically at a known site).
// Deliberately free of React / DB / expo-location imports so it unit-tests in
// plain Node — the haversine itself is reused from src/location/proximity.ts
// (same formula the location-list proximity sort uses).

import { distanceMeters, type LatLng } from '../location/proximity';

/** Default "you are at this site" radius for vehicle intake, metres. */
export const VEHICLE_INTAKE_RADIUS_M = 150;

/** Coords that may be missing (no GPS fix, un-anchored location row). */
export interface MaybeCoords {
  latitude?: number | null;
  longitude?: number | null;
}

/** Great-circle distance in metres (haversine). */
export function haversineMeters(a: LatLng, b: LatLng): number {
  return distanceMeters(a, b);
}

function asLatLng(c: MaybeCoords | null | undefined): LatLng | null {
  if (!c) return null;
  const { latitude, longitude } = c;
  if (latitude == null || longitude == null) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

/**
 * True iff BOTH coord pairs are present and within `radiusM` of each other.
 * Any missing/null coordinate (permission denied, no fix yet, un-anchored
 * location) degrades to false — proximity can gate a button, never crash it.
 */
export function isWithinRadius(
  deviceCoords: MaybeCoords | null | undefined,
  locationCoords: MaybeCoords | null | undefined,
  radiusM: number = VEHICLE_INTAKE_RADIUS_M,
): boolean {
  const device = asLatLng(deviceCoords);
  const location = asLatLng(locationCoords);
  if (!device || !location) return false;
  return haversineMeters(device, location) <= radiusM;
}

/**
 * The nearest candidate within `radiusM` of the device, or null. Candidates
 * without coords are skipped; a null device fix yields null. Ties keep the
 * earlier candidate (stable).
 */
export function nearestWithinRadius<L extends MaybeCoords>(
  deviceCoords: MaybeCoords | null | undefined,
  candidates: readonly L[],
  radiusM: number = VEHICLE_INTAKE_RADIUS_M,
): L | null {
  const device = asLatLng(deviceCoords);
  if (!device) return null;
  let best: L | null = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const coords = asLatLng(candidate);
    if (!coords) continue;
    const d = haversineMeters(device, coords);
    if (d <= radiusM && d < bestDist) {
      best = candidate;
      bestDist = d;
    }
  }
  return best;
}
