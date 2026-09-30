import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { getDb } from '../db/schema';
import { getAppConfig } from '../db/appConfig';
import { generateUUID } from '../utils/uuid';
import { redactProps, sanitizeLabel, BUFFER_CAP, excessToEvict } from './redact';

export type TelemetryType = 'screen' | 'action' | 'error' | 'audit';

export interface TrackOpts {
  screen?: string;
  props?: Record<string, unknown>;
}

// Per-launch session id: a module-scoped random id generated once at import,
// stable for the lifetime of this JS engine instance (cleared on cold start).
const SESSION_ID = generateUUID();

// Context attached (as headers, see flush.ts) to every batch sent to the
// server — not stored per-row on the client, since the buffer itself is
// ephemeral and short-lived.
export const TELEMETRY_CONTEXT = {
  session_id: SESSION_ID,
  // expo-constants' sessionId is unique per app launch/session — good enough
  // as a lightweight device/session correlator without adding a new
  // dependency (expo-application) just for telemetry.
  device_id: Constants.sessionId ?? SESSION_ID,
  platform: Platform.OS,
  app_version: Constants.expoConfig?.version ?? null,
};

// Kill-switch: EXPO_PUBLIC_TELEMETRY is a build-time default (bake '0' into a
// build to compile telemetry off entirely); app_config.telemetry_enabled is a
// remote override synced from the server that can flip capture+flush off
// without a rebuild. Either one set to '0' disables telemetry.
export function isTelemetryEnabled(): boolean {
  if (process.env.EXPO_PUBLIC_TELEMETRY === '0') return false;
  if (getAppConfig('telemetry_enabled') === '0') return false;
  return true;
}

/**
 * Records a behavioral event into the local ring buffer (telemetry_buffer).
 * Never blocks the UI, never throws, and never touches the business sync
 * outbox — this is a completely separate, lossy-by-design pipeline flushed by
 * flushTelemetry() (see flush.ts). `type` mirrors the server's
 * telemetry_events.type: screen | action | error | audit.
 */
export function track(type: TelemetryType, name: string, opts?: TrackOpts): void {
  try {
    if (!isTelemetryEnabled()) return;
    const props = redactProps(opts?.props);
    const cleanName = sanitizeLabel(name);
    if (!cleanName) return;
    const cleanScreen = opts?.screen ? sanitizeLabel(opts.screen) : null;
    const clientTs = new Date().toISOString();

    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.log('[telemetry]', type, cleanName, cleanScreen, props);
    }

    const db = getDb();
    db.executeSync(
      `INSERT INTO telemetry_buffer (type, name, screen, props, client_ts) VALUES (?, ?, ?, ?, ?)`,
      [type, cleanName, cleanScreen, JSON.stringify(props), clientTs],
    );

    // Enforce the ring-buffer cap: once over BUFFER_CAP, evict the oldest
    // rows first (lowest seq) so the buffer never grows unbounded when the
    // device is offline for a long stretch.
    const countRow = db.executeSync(`SELECT COUNT(*) as cnt FROM telemetry_buffer`)
      .rows[0] as { cnt: number } | undefined;
    const count = countRow?.cnt ?? 0;
    const evict = excessToEvict(count, BUFFER_CAP);
    if (evict > 0) {
      db.executeSync(
        `DELETE FROM telemetry_buffer WHERE seq IN (
           SELECT seq FROM telemetry_buffer ORDER BY seq ASC LIMIT ?
         )`,
        [evict],
      );
    }
  } catch {
    // Telemetry must never break the app.
  }
}
