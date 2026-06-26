export interface LatLng { latitude: number; longitude: number }

const R = 6371000; // earth radius, metres
const toRad = (d: number) => (d * Math.PI) / 180;

export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function sortByProximity<L extends { latitude: number | null; longitude: number | null }>(
  locations: L[],
  coords: LatLng | null,
): (L & { distanceM: number | null })[] {
  // Preserve original order; annotate distance; stable-sort anchored-by-distance, un-anchored last.
  const withIdx = locations.map((l, i) => {
    const anchored = coords && l.latitude != null && l.longitude != null;
    const distanceM = anchored
      ? distanceMeters(coords, { latitude: l.latitude as number, longitude: l.longitude as number })
      : null;
    return { l: { ...l, distanceM }, i, distanceM };
  });
  withIdx.sort((x, y) => {
    if (x.distanceM == null && y.distanceM == null) return x.i - y.i; // both un-anchored → original order
    if (x.distanceM == null) return 1;   // un-anchored sinks
    if (y.distanceM == null) return -1;
    return x.distanceM - y.distanceM || x.i - y.i;
  });
  return withIdx.map(w => w.l);
}
