// Pure repair-status-trail logic (no react / react-native / DB imports) so the
// derivation runs under plain `node --test` — precedent: vehicles/
// vehicleSessionLogic.ts. The repair detail screen supplies the taxonomy-
// ordered status list, this repair's activity_log rows, and the current
// status id; this module derives, per status, whether it's been visited,
// is current, or hasn't happened yet — no DB/query access here.

export interface StatusLike {
  id: string;
  label: string;
}

// The subset of a LogEntry this module needs. `pickStatus` (the repairs
// detail screen) writes exactly these two actions with note = `Status → <label>`
// — see `logStatus` in app/(app)/(repairs)/[id].tsx.
export interface StatusLogRowLike {
  action: string;
  note: string | null;
}

export type TrailTone = 'success' | 'primary' | 'neutral';

export interface TrailEntry {
  id: string;
  label: string;
  tone: TrailTone;
}

const STATUS_LOG_ACTIONS = new Set(['repair_status_changed', 'repair_completed']);
const STATUS_NOTE_RE = /^Status → (.+)$/;

/**
 * Which status labels this repair has actually passed through, per its
 * activity_log history. Extracted separately from buildStatusTrail so a
 * caller with its own log-row shape can still reuse the note-parsing rule.
 */
export function visitedStatusLabels(logRows: readonly StatusLogRowLike[]): Set<string> {
  const visited = new Set<string>();
  for (const row of logRows) {
    if (!STATUS_LOG_ACTIONS.has(row.action) || !row.note) continue;
    const m = STATUS_NOTE_RE.exec(row.note);
    if (m) visited.add(m[1]);
  }
  return visited;
}

/**
 * Builds the horizontal status-trail row: one entry per status (in taxonomy
 * sort_order), toned success (visited, per activity_log), primary (the
 * repair's current status — takes priority over "visited"), or neutral (not
 * yet reached). Order-agnostic: a status is "visited" only when the log
 * actually shows it, never inferred from sort_order position, so a repair
 * that skips a status (e.g. Open → Repaired) doesn't falsely mark the
 * skipped one as visited.
 */
export function buildStatusTrail(
  statusesInOrder: readonly StatusLike[],
  logRows: readonly StatusLogRowLike[],
  currentStatusId: string | null,
): TrailEntry[] {
  const visited = visitedStatusLabels(logRows);
  return statusesInOrder.map(st => ({
    id: st.id,
    label: st.label,
    tone: st.id === currentStatusId ? 'primary' : visited.has(st.label) ? 'success' : 'neutral',
  }));
}
