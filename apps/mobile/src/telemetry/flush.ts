import { getDb, rowsAs } from '../db/schema';
import { getValidJwt } from '../auth/session';
import { TELEMETRY_CONTEXT, isTelemetryEnabled } from './index';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const FLUSH_BATCH = 100;

interface BufferedRow {
  seq: number;
  type: string;
  name: string;
  screen: string | null;
  props: string | null;
  client_ts: string;
}

/**
 * Reads up to FLUSH_BATCH oldest buffered telemetry rows and POSTs them to
 * `${API_BASE}/telemetry`. Deletes the sent rows on a 2xx response; on any
 * failure (offline, 401, 5xx, etc.) leaves them buffered — they're retried on
 * the next sync cycle, or eventually dropped by the ring-buffer cap
 * (BUFFER_CAP in redact.ts). Never throws: telemetry loss is acceptable,
 * disturbing the business sync cadence is not. Deliberately NOT on the
 * business outbox/push request — its own transport, its own endpoint.
 */
export async function flushTelemetry(): Promise<void> {
  try {
    if (!isTelemetryEnabled()) return;

    const db = getDb();
    const rows = rowsAs<BufferedRow>(
      db.executeSync(
        `SELECT seq, type, name, screen, props, client_ts FROM telemetry_buffer ORDER BY seq ASC LIMIT ?`,
        [FLUSH_BATCH],
      ).rows,
    );
    if (rows.length === 0) return;

    const jwt = await getValidJwt();
    if (!jwt) return; // no session yet — leave buffered, retried next cycle

    const events = rows.map(r => ({
      type: r.type,
      name: r.name,
      screen: r.screen,
      props: r.props ? JSON.parse(r.props) : {},
      client_ts: r.client_ts,
    }));

    const res = await fetch(`${API_BASE}/telemetry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
        'x-telemetry-session': TELEMETRY_CONTEXT.session_id,
        'x-telemetry-device': TELEMETRY_CONTEXT.device_id,
        'x-telemetry-platform': TELEMETRY_CONTEXT.platform,
        'x-telemetry-appver': TELEMETRY_CONTEXT.app_version ?? '',
      },
      body: JSON.stringify({ events }),
    });

    if (!res.ok) return; // leave rows buffered; retried next cycle

    const seqs = rows.map(r => r.seq);
    const placeholders = seqs.map(() => '?').join(',');
    db.executeSync(`DELETE FROM telemetry_buffer WHERE seq IN (${placeholders})`, seqs);
  } catch {
    // Fire-and-forget: offline/errors just leave rows buffered for next cycle.
  }
}
