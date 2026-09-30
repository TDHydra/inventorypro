import { useCallback, useState } from 'react';
import { getAppConfig } from '../db/appConfig';
import { getDb, rowsAs } from '../db/schema';
import { getCachedPosition } from '../location/positionCache';
import { nearestWithinRadius, VEHICLE_INTAKE_RADIUS_M } from './vehicleIntakeMath';

// #84 vehicle intake: a crew member (no manage_locations) may add a Vehicle
// location, but ONLY while the org flag `crew_add_vehicle_enabled` is '1' AND
// the device is physically at a known site (an anchored location within 150m).
// The server mirrors both gates on /sync/push — this hook just decides whether
// the "Add a vehicle" button is worth rendering.

export interface NearbyIntakeLocation {
  id: string;
  name: string;
}

export interface VehicleIntakeState {
  /** The `crew_add_vehicle_enabled` app_config flag is '1'. */
  enabled: boolean;
  /** Nearest coord-anchored location the device is currently at, or null. */
  nearbyLocation: NearbyIntakeLocation | null;
  /** Re-resolve flag + proximity (e.g. on pull-to-refresh / screen focus). */
  refresh: () => void;
}

interface AnchoredLocationRow {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
}

function getAnchoredLocations(): AnchoredLocationRow[] {
  try {
    const result = getDb().executeSync(
      `SELECT id, name, latitude, longitude FROM locations
       WHERE active = 1 AND latitude IS NOT NULL AND longitude IS NOT NULL`,
    );
    return rowsAs<AnchoredLocationRow>(result.rows);
  } catch {
    return []; // db not open yet / table missing — degrade to "not nearby"
  }
}

function resolveIntake(): { enabled: boolean; nearbyLocation: NearbyIntakeLocation | null } {
  const enabled = getAppConfig('crew_add_vehicle_enabled') === '1';
  if (!enabled) return { enabled: false, nearbyLocation: null };
  // Synchronous read of the foreground fix primeLocation() keeps warm for the
  // logging layer (same source appendLog stamps coords from) — no new
  // permission prompt, no polling. A null fix simply means "not nearby".
  const device = getCachedPosition();
  if (!device) return { enabled, nearbyLocation: null };
  const nearest = nearestWithinRadius(device, getAnchoredLocations(), VEHICLE_INTAKE_RADIUS_M);
  return { enabled, nearbyLocation: nearest ? { id: nearest.id, name: nearest.name } : null };
}

/**
 * Poll-free #84 gate: resolves once on mount, and again only when the consumer
 * calls `refresh()`. The crew source-picker renders its "Add a vehicle" button
 * when `enabled && nearbyLocation`.
 */
export function useVehicleIntake(): VehicleIntakeState {
  const [state, setState] = useState(resolveIntake);
  const refresh = useCallback(() => setState(resolveIntake()), []);
  return { enabled: state.enabled, nearbyLocation: state.nearbyLocation, refresh };
}
