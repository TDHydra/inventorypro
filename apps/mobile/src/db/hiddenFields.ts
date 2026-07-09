import { getAppConfig, setAppConfigLocal } from './appConfig';
import { appendOutbox } from '../sync/outbox';
import { appendLog } from './queries/log';
import { FormFieldId, ALL_FORM_FIELD_IDS } from '../constants/formFields';

const HIDDEN_FIELDS_KEY = 'hidden_fields';

// Version counter + listeners for sync reactivity (same pattern as permissions.ts).
// Bumping cacheVersion causes useSyncExternalStore in useHiddenFields to re-read
// the DB and re-render any components gated by HidableField. notifyHiddenFieldsChanged
// is called: (a) by the settings screen after each toggle commit, and (b) by the sync
// engine after a pull so field visibility updates immediately without requiring a
// focus event.
let cacheVersion = 0;
const listeners = new Set<() => void>();

export function subscribeHiddenFields(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getHiddenFieldsVersion(): number {
  return cacheVersion;
}

/** Bump the version counter so all useHiddenFields subscribers re-render. */
export function notifyHiddenFieldsChanged(): void {
  cacheVersion++;
  listeners.forEach(l => l());
}

/**
 * Read the current set of hidden field IDs from app_config.
 * Falls back to an empty set on any error (missing key / invalid JSON / unknown ids).
 */
export function getHiddenFields(): Set<FormFieldId> {
  try {
    const raw = getAppConfig(HIDDEN_FIELDS_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    const valid = (parsed as unknown[]).filter(
      (v): v is FormFieldId =>
        typeof v === 'string' && (ALL_FORM_FIELD_IDS as string[]).includes(v),
    );
    return new Set(valid);
  } catch {
    return new Set();
  }
}

/**
 * Persist the full set of hidden fields to app_config and push through the
 * outbox so the change syncs to every device.
 * Does NOT bump the version counter — call notifyHiddenFieldsChanged() after
 * the enclosing runInTransaction succeeds (mirrors the roles.tsx pattern).
 */
export function setHiddenFields(fields: Set<FormFieldId>): void {
  const value = JSON.stringify(Array.from(fields));
  setAppConfigLocal(HIDDEN_FIELDS_KEY, value);
  appendOutbox('INSERT', 'app_config', {
    key: HIDDEN_FIELDS_KEY,
    value,
    updated_at: new Date().toISOString(),
  });
}

/**
 * Toggle a single field's hidden state, persist it, and write an activity log
 * row. Intended to be called inside a runInTransaction block so the app_config
 * write and the log entry are atomic. Call notifyHiddenFieldsChanged() after
 * the transaction commits.
 */
export function toggleHiddenField(
  id: FormFieldId,
  hidden: boolean,
  userId?: string | null,
): void {
  const fields = getHiddenFields();
  if (hidden) {
    fields.add(id);
  } else {
    fields.delete(id);
  }
  setHiddenFields(fields);
  appendLog({
    action: 'hidden_field_changed',
    entity_type: 'app_config',
    entity_id: null,
    user_id: userId ?? null,
    note: `${id}: ${hidden ? 'hidden' : 'shown'}`,
    team_id: null,
    from_location_id: null,
    to_location_id: null,
    quantity: null,
    unit: null,
    job_id: null,
    metadata: JSON.stringify({ field_id: id, hidden }),
    device_id: null,
  });
}
