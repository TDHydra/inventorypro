// Pure, unit-tested approval-workflow policy. Extracted from routes/sync.ts so the
// status-transition guard, decision-notification trigger, and threshold auto-flag
// predicate can be exercised without a database. The sync hooks import these and
// supply the async context (pre-row read, recipient resolution) around them.

export type MovementOp = {
  operation: string;
  table_name: string;
  payload: Record<string, unknown>;
};

// Parse the admin-configured approval threshold (app_config.approval_threshold_qty,
// stored as a numeric string). Blank / undefined / 0 / negative / garbage → 0,
// which disables the auto-flag feature entirely.
export function parseThreshold(value: string | undefined | null): number {
  if (value == null) return 0;
  const n = parseInt(String(value).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// True when an op is a stock_by_location signed-delta ADJUST whose absolute
// magnitude meets/exceeds the threshold — i.e. a "large" checkout/transfer leg that
// should be auto-flagged for approval. threshold <= 0 disables the check. Any
// non-numeric / non-ADJUST / non-stock op → false.
export function isThresholdMovement(op: MovementOp | undefined | null, threshold: number): boolean {
  if (!(threshold > 0)) return false;
  if (!op || op.table_name !== 'stock_by_location' || op.operation !== 'ADJUST') return false;
  const raw = op.payload?.delta;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return false;
  return Math.abs(n) >= threshold;
}

// True only for a genuine open -> decided transition (approved/rejected) — the one
// case that notifies the requester. Retries (pre already decided), no-op updates
// (pre === next), and requester cancellations do NOT notify.
export function shouldNotifyDecision(
  pre: string | null | undefined,
  next: string | null | undefined,
): boolean {
  return pre === 'open' && (next === 'approved' || next === 'rejected');
}

// Authorization for a decision-field UPDATE to an approval_requests row (the caller
// is writing status/decided_by/decided_at/decision_note). Approvers (recipients of
// the 'approvals' channel, or a manage_teams / full_admin holder) may set any
// decision; the requester may only CANCEL their own request. Everyone else is
// rejected (surfaces as a sync push conflict). The caller decides *whether* a
// decision field was touched; this function only decides *who* may. `changesStatus`
// is retained for the requester-cancel check (a requester may touch decision fields
// only to move status → cancelled).
export function approvalUpdateAllowed(opts: {
  changesStatus: boolean;
  nextStatus?: string | null;
  callerIsApprover: boolean;
  callerIsRequester: boolean;
}): { allowed: boolean; reason?: string } {
  if (opts.callerIsApprover) return { allowed: true };
  if (opts.callerIsRequester && opts.changesStatus && opts.nextStatus === 'cancelled') return { allowed: true };
  return { allowed: false, reason: 'Forbidden: only an approver may decide this request' };
}
