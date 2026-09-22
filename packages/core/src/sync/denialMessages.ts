// Pure mapping from a PERMANENTLY-denied outbox entry (table + operation) to a
// human-readable message for SyncIndicator's denied bucket (#202).
//
// engine.ts calls denialMessage() the moment a push rejection is classified
// PERMANENT (see PERMANENT_REJECTION in engine.ts — an authorization denial
// the server will never reverse just by retrying) and stores the result via
// markOutboxDenied() instead of the server's raw rejection string. The raw
// string (e.g. "Forbidden: teams requires manage_teams") names an internal
// permission key that means nothing to whoever tapped Save; this module names
// the ENTITY instead.
//
// No react-native / expo / db imports — this must load and run under plain
// `node:test` via tsx, same constraint as mediaPrefetchRules.ts.

export type DeniedOutboxOperation = 'INSERT' | 'UPDATE' | 'DELETE' | 'ADJUST';

export interface DeniedOutboxEntryInfo {
  table_name: string;
  operation: DeniedOutboxOperation;
}

// table_name -> plural, human-facing label for the entity it stores. Kept
// deliberately short (a phrase, not a sentence) — denialMessage() wraps it.
// Extend this as new synced tables gain write-permission gates; an unmapped
// table still gets a sensible fallback (see entityLabel below), so a missing
// entry here is a wording gap, not a bug.
const ENTITY_LABELS: Record<string, string> = {
  schedule_assignments: 'schedules',
  job_assignments: 'job assignments',
  jobs: 'jobs',
  teams: 'teams',
  users: 'users',
  inventory_items: 'inventory items',
  equipment_units: 'equipment',
  locations: 'locations',
  vehicles: 'vehicles',
  repairs: 'repairs',
  media: 'photos',
  activity_log: 'activity log entries',
  role_settings: 'role settings',
  dashboard_presets: 'dashboards',
  chat_messages: 'chat messages',
  on_call_shifts: 'on-call shifts',
  notifications: 'notifications',
  app_config: 'app settings',
};

// Fallback for a table_name with no entry above: humanize the raw identifier
// ('gas_receipts' -> 'gas receipts') rather than showing nothing or the SQL
// name verbatim. Exported (#203) so the "Request access" funnel's generic
// draft message can name the same entity denialMessage() already shows,
// instead of re-deriving it a second way and risking the wording drifting.
export function entityLabel(tableName: string): string {
  return ENTITY_LABELS[tableName] ?? tableName.replace(/_/g, ' ');
}

// Deleting is worded distinctly ("can't delete X"); INSERT/UPDATE/ADJUST all
// collapse to "can't edit X" — from the server's point of view these are all
// the same write-permission gate, and "edit" reads naturally for a new row too
// ("Your account can't edit schedules" covers "add" and "change" alike).
function verbFor(operation: DeniedOutboxOperation): string {
  return operation === 'DELETE' ? 'delete' : 'edit';
}

// The friendly message shown in the SyncIndicator's denied bucket for a single
// entry. Deliberately does not surface the server's raw error text — see the
// module comment above.
export function denialMessage(entry: DeniedOutboxEntryInfo): string {
  const label = entityLabel(entry.table_name);
  const verb = verbFor(entry.operation);
  return `Your account can't ${verb} ${label} — this change wasn't saved.`;
}

// #235: engine.ts's pushEntries stores a raw `HTTP <status>: <body>` string in
// last_error for a non-2xx /sync/push response (a proxy/server hiccup, not a
// rejection the server ever got to classify) — meaningless to whoever opens
// SyncIndicator's failed bucket. Specific statuses first (502/503/504 read
// better than the generic 500-class message); everything else, including any
// status this doesn't recognize, is returned unchanged.
const HTTP_STATUS_MESSAGES: Record<number, string> = {
  408: 'Timed out — will retry',
  429: 'Server busy — will retry',
  502: 'Server unavailable — will retry',
  503: 'Server unavailable — will retry',
  504: 'Server unavailable — will retry',
};

const HTTP_STATUS_PREFIX = /^HTTP (\d{3}):/;

export function readableFailureReason(rawError: string): string {
  const m = HTTP_STATUS_PREFIX.exec(rawError);
  if (!m) return rawError;
  const status = Number(m[1]);
  if (HTTP_STATUS_MESSAGES[status]) return HTTP_STATUS_MESSAGES[status];
  if (status >= 500 && status < 600) return 'Server error — will retry';
  return rawError;
}
