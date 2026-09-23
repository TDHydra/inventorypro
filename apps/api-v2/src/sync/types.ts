// Shared types for the manifest-driven sync pipeline (Phase 7 rewrite).
// The route file (routes/sync.ts) is a thin skeleton; every per-table rule
// lives in a guard module under sync/guards/, registered in sync/guards/index.ts
// in the SAME relative order the old monolith checked them — rejection
// precedence is part of the wire contract the golden test pins down.

import type { Caller } from '../lib/scoping';
import type { ShareEmailSender } from '../lib/shareEmail';

export type Pg = { query: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }> };

export interface OutboxEntry {
  id: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'ADJUST';
  table_name: string;
  payload: Record<string, unknown>;
  created_at: string;
}

// #235: a stable, machine-readable companion to each conflict's free-text
// `error` (that text is allowed to change wording; the mobile client — and
// any future integration — should classify on this instead of string-
// matching). FORBIDDEN/NOT_ALLOWED/VALIDATION are permanent (the mobile
// engine's isPermanentRejection treats them like the legacy regex match);
// MAINTENANCE and CONFLICT are transient (retried, bounded by MAX_ATTEMPTS).
export type SyncRejectionCode = 'FORBIDDEN' | 'VALIDATION' | 'MAINTENANCE' | 'NOT_ALLOWED' | 'CONFLICT';

export interface Rejection {
  error: string;
  code: SyncRejectionCode;
}

// Batch-scoped mutable state shared by guards across the entries of ONE push.
export interface BatchState {
  // #129: duplicate Vehicle-typed location id -> survivor id (in-batch remap).
  vehicleAlias: Map<string, string>;
  // Items touched by ADJUSTs this batch — one low-stock check per item AFTER
  // the whole batch commits (avoids the transfer race + re-arm gap).
  touchedItems: Set<string>;
  // media DELETE pre-capture (entry id -> row) so afterApply can clean MinIO
  // objects for a row that no longer exists.
  mediaCleanup: Map<string, { id: string; url: string; thumbnail_url: string | null }>;
  // #129: merged[] response rows (client re-points local rows at the survivor).
  merged: Array<{ id: string; duplicate_id: string; survivor_id: string }>;
}

export interface SyncCtx {
  pg: Pg;
  userId: string;
  caller: Caller;
  can: (perm: string) => boolean;
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
  batch: BatchState;
  // Set by a guard when a rejected write looks like schema/table probing —
  // the request audit hook records outcome 'injection_attempt'.
  flagInjectionAttempt: () => void;
  // Injected email sender (me.ts:51-56 pattern): production gets the real
  // SMTP-backed sender; tests inject a stub. Used by the media pool-share leg.
  shareEmailSender: ShareEmailSender;
}

// A guard either rejects the entry, marks it handled (ok'd without applying —
// the vehicle-duplicate merge), or lets it pass (undefined).
export type GuardVerdict = Rejection | { handled: true } | undefined;

export interface TableGuard {
  /** Table this guard applies to, or '*' for every entry. */
  table: string | '*';
  /** Runs BEFORE the test-account / maintenance / privileged-table gates
   *  (old monolith order: the activity_log action gate). */
  preAuthorize?(ctx: SyncCtx, entry: OutboxEntry): Promise<Rejection | undefined>;
  /** Runs right after the privileged-table permission gate (app_config
   *  demo_mode, role_settings tier guards). */
  privileged?(ctx: SyncCtx, entry: OutboxEntry): Promise<Rejection | undefined>;
  /** Runs after the operation-permission gate — per-row authorization,
   *  payload normalisation, pre-capture. Ordering across guards follows
   *  registration order (see guards/index.ts). */
  authorizeRow?(ctx: SyncCtx, entry: OutboxEntry): Promise<GuardVerdict>;
  /** Runs after applyEntry succeeded for this entry (fire-and-forget side
   *  effects — notifications, media object cleanup, perm-touch). */
  afterApply?(ctx: SyncCtx, entry: OutboxEntry): void | Promise<void>;
}
