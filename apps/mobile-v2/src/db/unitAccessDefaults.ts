// Ported from apps/mobile/src/db/unitAccessDefaults.ts (Station B3 read-only
// subset, Station C4 write path). Import mapping applied
// (docs/REBUILD-PORTING.md):
//   './appConfig' (getAppConfig/setAppConfigLocal) → '@invenpro/core'
//   '../sync/outbox' (appendOutbox) → '@invenpro/core' (app_config has no
//     repo — same "legit direct appendOutbox caller" pattern already used by
//     hiddenFields.ts/maintenance.ts/qrSignConfig.ts/orgTheme.ts/formMode.ts)
//   version counter + listeners → identical shape to hiddenFields.ts's
//     subscribeHiddenFields/getHiddenFieldsVersion/notifyHiddenFieldsChanged
//     (the same "sync pull won't show until remount" problem, same fix)
//
// Station C4: the admin per-role defaults TEMPLATE EDITOR is now wired in —
// setUnitAccessDefaults + the version/listener pair below, the
// useUnitAccessDefaults hook (src/hooks/useUnitAccessDefaults.ts), and a
// "Defaults" section added to app/(app)/access/index.tsx (extending Station
// B3's existing unit-access surface rather than duplicating a standalone
// (admin)/unit-access-defaults.tsx screen, per the Station C4 brief).
import { getAppConfig, setAppConfigLocal, appendOutbox } from '@invenpro/core';
import { appendLog } from './queries/log';
import { ROLE_TIER } from '../constants/roles';

export const UNIT_ACCESS_DEFAULTS_KEY = 'unit_access_defaults';

export interface UnitAccessActions {
  view: boolean; add: boolean; remove: boolean; move: boolean;
  editDetails: boolean; grant: boolean;
}

// What a brand-new grant confers when the admin hasn't configured the role —
// identical to what the old app's migration 046/058 gave copied
// locker_access rows.
export const FALLBACK_ACTIONS: UnitAccessActions = {
  view: true, add: true, remove: true, move: true, editDetails: false, grant: false,
};

// Version counter + listeners (hiddenFields.ts pattern): synced config that
// gates UI must notify subscribers or changes don't show until remount.
// notifyUnitAccessDefaultsChanged is called by the settings section after
// each commit and (once the sync engine grows a post-pull hook here, matching
// hiddenFields' own not-yet-wired pull hook) after every pull.
let cacheVersion = 0;
const listeners = new Set<() => void>();

export function subscribeUnitAccessDefaults(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getUnitAccessDefaultsVersion(): number {
  return cacheVersion;
}

/** Bump the version counter so all useUnitAccessDefaults subscribers re-render. */
export function notifyUnitAccessDefaultsChanged(): void {
  cacheVersion++;
  listeners.forEach(l => l());
}

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
 * Persist the whole template + push through the outbox (server gates
 * app_config on system_settings). Does NOT bump the version — call
 * notifyUnitAccessDefaultsChanged() after the enclosing transaction commits
 * (mirrors setHiddenFields' contract).
 */
export function setUnitAccessDefaults(map: Record<string, UnitAccessActions>): void {
  const value = JSON.stringify(map);
  setAppConfigLocal(UNIT_ACCESS_DEFAULTS_KEY, value);
  appendOutbox('INSERT', 'app_config', {
    key: UNIT_ACCESS_DEFAULTS_KEY, value, updated_at: new Date().toISOString(),
  });
}

/**
 * Toggle a single (role, action) cell, persist the whole template, and write
 * an activity log row. Intended to be called inside a runInTransaction block
 * so the app_config write and the log entry are atomic (mirrors
 * hiddenFields.ts's toggleHiddenField). Call notifyUnitAccessDefaultsChanged()
 * after the transaction commits.
 */
export function toggleUnitAccessDefault(
  role: string,
  action: keyof UnitAccessActions,
  value: boolean,
  userId?: string | null,
): void {
  const defaults = getUnitAccessDefaults();
  const next: Record<string, UnitAccessActions> = {
    ...defaults,
    [role]: { ...(defaults[role] ?? FALLBACK_ACTIONS), [action]: value },
  };
  setUnitAccessDefaults(next);
  appendLog({
    action: 'unit_access_defaults_changed',
    entity_type: 'app_config',
    entity_id: null,
    user_id: userId ?? null,
    note: `${role}.${action}: ${value}`,
    team_id: null,
    from_location_id: null,
    to_location_id: null,
    quantity: null,
    unit: null,
    job_id: null,
    metadata: JSON.stringify({ role, action, value }),
    device_id: null,
  });
}
