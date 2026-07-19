import { getAppConfig, setAppConfigLocal } from './appConfig';
import { appendOutbox } from '../sync/outbox';
import { ROLE_TIER } from '../constants/roles';

// Admin-configured per-role defaults for NEW unit_access grants (#122 Phase B),
// synced via app_config. Version counter + listeners (hiddenFields.ts pattern):
// synced config that gates UI must notify subscribers or changes don't show
// until remount. notifyUnitAccessDefaultsChanged is called by the settings
// screen after each commit and by the sync engine after every pull.
export const UNIT_ACCESS_DEFAULTS_KEY = 'unit_access_defaults';

export interface UnitAccessActions {
  view: boolean; add: boolean; remove: boolean; move: boolean;
  editDetails: boolean; grant: boolean;
}

// What a brand-new grant confers when the admin hasn't configured the role —
// identical to what migration 046/058 gave copied locker_access rows.
export const FALLBACK_ACTIONS: UnitAccessActions = {
  view: true, add: true, remove: true, move: true, editDetails: false, grant: false,
};

let cacheVersion = 0;
const listeners = new Set<() => void>();
export function subscribeUnitAccessDefaults(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}
export function getUnitAccessDefaultsVersion(): number { return cacheVersion; }
export function notifyUnitAccessDefaultsChanged(): void { cacheVersion++; listeners.forEach(l => l()); }

const ACTION_KEYS = ['view', 'add', 'remove', 'move', 'editDetails', 'grant'] as const;

/** Pure parse — tolerant of missing key, bad JSON, unknown roles, partial maps. */
export function parseUnitAccessDefaults(raw: string | null): Record<string, UnitAccessActions> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, UnitAccessActions> = {};
    for (const [role, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(role in ROLE_TIER) || v === null || typeof v !== 'object' || Array.isArray(v)) continue;
      const m = v as Record<string, unknown>;
      const actions = { ...FALLBACK_ACTIONS };
      for (const k of ACTION_KEYS) {
        if (typeof m[k] === 'boolean') actions[k] = m[k] as boolean;
      }
      out[role] = actions;
    }
    return out;
  } catch {
    return {};
  }
}

export function getUnitAccessDefaults(): Record<string, UnitAccessActions> {
  return parseUnitAccessDefaults(getAppConfig(UNIT_ACCESS_DEFAULTS_KEY));
}

/** The actions a new grant for `role` should start with. */
export function getDefaultActionsForRole(role: string): UnitAccessActions {
  return getUnitAccessDefaults()[role] ?? FALLBACK_ACTIONS;
}

/**
 * Persist the whole template + push through the outbox (server gates app_config
 * on system_settings). Does NOT bump the version — call
 * notifyUnitAccessDefaultsChanged() after the enclosing transaction commits.
 */
export function setUnitAccessDefaults(map: Record<string, UnitAccessActions>): void {
  const value = JSON.stringify(map);
  setAppConfigLocal(UNIT_ACCESS_DEFAULTS_KEY, value);
  appendOutbox('INSERT', 'app_config', {
    key: UNIT_ACCESS_DEFAULTS_KEY, value, updated_at: new Date().toISOString(),
  });
}
