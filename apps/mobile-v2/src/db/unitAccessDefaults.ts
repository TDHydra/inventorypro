// Ported from apps/mobile/src/db/unitAccessDefaults.ts — READ-ONLY subset
// only (Station B3). The admin per-role defaults TEMPLATE EDITOR (the setter
// setUnitAccessDefaults + version/listener pair + the
// (admin)/unit-access-defaults.tsx screen + useUnitAccessDefaults.ts hook) is
// CUT this wave (see docs/REBUILD-NOTES.md Wave B section) — nothing in this
// station's scope configures per-role overrides yet, so
// grantUnitAccessWithDefaults (repos/access.ts) simply always resolves to
// FALLBACK_ACTIONS until that admin screen is ported (TODO(wave-C)).
import { getAppConfig } from '@invenpro/core';
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
