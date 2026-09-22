// Telemetry seam — Phase 2 stub. The old app's full pipeline (telemetry_buffer
// table, Sentry capture, screen tracking) returns in Wave D; until then track()
// is a console-level no-op so ported call sites (queries/log.ts) compile and
// the core track seam has something to point at.
export type TrackKind = 'error' | 'audit';

export function track(
  kind: TrackKind,
  name: string,
  opts?: { props?: Record<string, unknown> },
): void {
  if (kind === 'error') console.warn(`[telemetry:${kind}] ${name}`, opts?.props ?? '');
}
