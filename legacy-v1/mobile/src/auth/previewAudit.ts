// #233: audit trail for #199 "preview as role" sessions. Pure derivation of
// WHAT to log from a previewRole state transition — kept framework/DB-free
// (same precedent as requestAccess.ts / useSession.ts's deriveEffectiveUser)
// so it's unit-testable without pulling in op-sqlite. The single call site
// (app/_layout.tsx, the SessionContext provider — the one choke point every
// setPreviewRole call funnels through) turns each returned event into an
// appendLog() row.
import type { UserRole } from '../constants/roles';

export interface PreviewAuditEvent {
  type: 'preview_started' | 'preview_ended';
  role: UserRole;
}

/**
 * Diffs the previous vs. next `previewRole` and returns the audit event(s)
 * to log, in order. Handles the direct A -> B switch (roles.tsx's picker
 * calls setPreviewRole(role) straight from one non-null role to another,
 * never routing through null first) as an implicit end-of-A + start-of-B so
 * the trail always shows a start for every end and vice versa.
 */
export function derivePreviewAuditEvents(
  prevRole: UserRole | null,
  nextRole: UserRole | null,
): PreviewAuditEvent[] {
  if (prevRole === nextRole) return [];
  const events: PreviewAuditEvent[] = [];
  if (prevRole != null) events.push({ type: 'preview_ended', role: prevRole });
  if (nextRole != null) events.push({ type: 'preview_started', role: nextRole });
  return events;
}
