import { createContext, useContext } from 'react';
import { UserRole } from '../constants/roles';
import { UserSession } from '../auth/permissions';

export interface SessionContextValue {
  /**
   * Effective user — the one nearly everyone should read. Normally identical
   * to `realUser`. When a preview (#199) is active it's the real identity with
   * `role` swapped for the previewed role and `permission_overrides` /
   * `team_contexts` emptied, so hasPermission()/usePermission()/PermissionGate
   * resolve ONLY that role's defaults + role_settings overrides (layers 1-1b
   * in hasPermission's resolution order) — no leftover team/user override from
   * the real identity can leak into the pretend role. Picked up by normal React
   * re-render; no separate reactive cache needed.
   */
  user: UserSession | null;
  /**
   * The untouched, real signed-in user. Identity/audit-sensitive consumers
   * MUST read this instead of `user` — activity-log/outbox actor attribution,
   * hierarchy self-checks that mirror server-side authoritative enforcement,
   * and anything persisted (login, PIN, session storage). See #199 audit notes
   * in app/_layout.tsx and the call sites switched alongside this file.
   */
  realUser: UserSession | null;
  setUser: (user: UserSession | null) => void;
  /** Role currently being previewed, or null when no preview is active (the
   * default — `user` and `realUser` are then the same object). */
  previewRole: UserRole | null;
  setPreviewRole: (role: UserRole | null) => void;
  logout: () => Promise<void>;
}

/**
 * Pure derivation of the effective user from the real user + an optional
 * preview role (#199 core). Extracted from the provider so it's unit-testable
 * without touching React/DB. Only `role` is swapped and the two override
 * layers that are specific to the REAL identity (`permission_overrides`,
 * `team_contexts`) are cleared — every other field (id, name, pin settings,
 * active/expiry, is_test...) passes through untouched, so id-keyed logic
 * (activity-log attribution, "is this me" checks) behaves the same whether or
 * not a preview is active; only role-resolved permission checks change.
 *
 * Returns the SAME object reference when no preview is active, so consumers
 * relying on referential equality (memo deps, etc.) see zero change from
 * today's behavior.
 */
export function deriveEffectiveUser(
  realUser: UserSession | null,
  previewRole: UserRole | null,
): UserSession | null {
  if (!realUser || !previewRole) return realUser;
  return {
    ...realUser,
    role: previewRole,
    permission_overrides: {},
    team_contexts: [],
  };
}

export const SessionContext = createContext<SessionContextValue>({
  user: null,
  realUser: null,
  setUser: () => {},
  previewRole: null,
  setPreviewRole: () => {},
  logout: async () => {},
});

export function useSession(): SessionContextValue {
  return useContext(SessionContext);
}
