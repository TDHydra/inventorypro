import NetInfo from './netinfo';
import { AppState, AppStateStatus } from 'react-native';
import { getPendingOutbox, markOutboxSynced, incrementOutboxAttempt, markOutboxDenied, dropOutboxEntry, retryFailedOutbox, getPendingLogCount, getOutboxCounts, getDeniedCount, OutboxEntry, MAX_OUTBOX_ATTEMPTS } from './outbox';
import { shouldEmitHeartbeat } from './heartbeat';
import { denialMessage } from './denialMessages';
import { isPermanentRejection } from './rejectionClassify';
import { pullChanges } from './pull';
import { isSandboxActive } from './sandbox';
import { reconcileTeams } from './teamPurge';
import { reconcileChat } from './chatPurge';
import { reconcileLogSyncState } from '../db/queries/log';
import { getValidJwt, getSavedUserId } from '../auth/session';
import { loadClassConfigCache } from '../constants/units';
import { loadRolePermissionCache } from '../auth/permissions';
import { loadDashboardCache } from '../dashboard/store';
import { loadChatCache } from '../chat/store';
import { notifyHiddenFieldsChanged } from '../db/hiddenFields';
import { notifyUnitAccessDefaultsChanged } from '../db/unitAccessDefaults';
import { applyUserTheme } from '../db/userPrefs';
import { applyOrgDefaultTheme } from '../db/orgTheme';
import { runLocalAlertChecks } from '../notifications/localAlerts';
import { prefetchNewMediaThumbnails } from './mediaPrefetch';
import { track } from '../telemetry';
import { flushTelemetry } from '../telemetry/flush';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const MAX_ATTEMPTS = MAX_OUTBOX_ATTEMPTS;
const INTERVAL_MS = 60_000;
const FAST_RETRY_MS = 10_000;

let running = false;
let started = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
let fastRetryId: ReturnType<typeof setTimeout> | null = null;
let netInfoUnsub: (() => void) | null = null;
let appStateUnsub: (() => void) | null = null;

// True if the outbox still holds entries we're allowed to keep retrying.
// Entries that have exhausted MAX_ATTEMPTS are excluded so a permanently
// failing row can't pin the fast-retry loop on forever.
function hasDeliverableWork(): boolean {
  return getPendingOutbox(1).some(e => e.attempts < MAX_ATTEMPTS);
}

// Arm a single fast retry ~10s out. Debounced: if one is already armed we
// don't stack a second; it's cleared as soon as a cycle actually runs.
function scheduleFastRetry(): void {
  if (fastRetryId) return;
  fastRetryId = setTimeout(() => {
    fastRetryId = null;
    syncCycle();
  }, FAST_RETRY_MS);
}

// Fires 'outbox_dead' the moment an entry's attempt count crosses
// MAX_ATTEMPTS (i.e. it just fell out of the active retry set) — not on every
// subsequent cycle, since the entry stays in this dead state indefinitely.
function trackIfNewlyDead(e: OutboxEntry): void {
  if (e.attempts + 1 >= MAX_ATTEMPTS) {
    track('error', 'outbox_dead', { props: { table: e.table_name, operation: e.operation, attempts: e.attempts + 1 } });
  }
}

// #236: fleet sync-health heartbeat state. Module-level (not persisted) —
// a cold start just re-emits once, which is fine since the throttle only
// exists to stop a chatty stuck-outbox from spamming every ~10s fast-retry
// cycle, not to dedupe across app restarts.
let lastHeartbeatAt: number | null = null;
let lastHeartbeatCountsNonzero = false;

// Emits at most one 'outbox_heartbeat' telemetry event per completed sync
// cycle, gated by shouldEmitHeartbeat's throttle/transition rules (see
// heartbeat.ts). `denied` comes from getDeniedCount() separately —
// getOutboxCounts() only covers the active/failed buckets (denied = 1 rows
// are excluded there by design, see outbox.ts).
function emitOutboxHeartbeat(): void {
  // Demo/test sessions never push or pull (see runDrainAndPull) — their
  // throwaway outbox state must not reach fleet telemetry either.
  if (isSandboxActive()) return;
  const { active, failed } = getOutboxCounts();
  const denied = getDeniedCount();
  const counts = { pending: active, failed, denied };
  const now = Date.now();
  if (!shouldEmitHeartbeat(now, lastHeartbeatAt, counts, lastHeartbeatCountsNonzero)) return;
  track('audit', 'outbox_heartbeat', { props: counts });
  lastHeartbeatAt = now;
  lastHeartbeatCountsNonzero = counts.pending > 0 || counts.failed > 0 || counts.denied > 0;
}

// #235: the permanent-vs-transient classification itself now lives in
// rejectionClassify.ts (pure, node:test-able — engine.ts pulls in react-native/
// expo modules that block plain node:test). It prefers the server's `code`
// field when present (apps/api/src/routes/sync.ts's conflicts.push sites) and
// falls back to the legacy 'forbidden'/'cannot'/'not allowed' wording match
// for servers that predate it.

// #235: the server sets X-Request-Id on every response (see apps/api/src/
// index.ts's onRequest hook) — fetch's Headers is case-insensitive, so this
// reads it regardless of casing. Appended to a stored error so a support
// ticket quoting "Ref: <id>" can be traced straight to the request server-side
// (and its audit_log row), without adding an outbox schema column.
function withRequestRef(message: string, res: Response): string {
  const reqId = res.headers.get('x-request-id');
  return reqId ? `${message} [ref ${reqId}]` : message;
}

// POSTs one batch and applies the server's verdict to the outbox. Shared by the
// regular drain and the activity_log-only drain (pushPendingLogs), so the
// permanent-vs-transient conflict rules below hold identically for both.
// Returns how many entries the server accepted.
async function pushEntries(entries: OutboxEntry[], jwt: string): Promise<number> {
  const res = await fetch(`${API_BASE}/sync/push`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ entries }),
  });

  if (!res.ok) {
    const errText = await res.text();
    entries.forEach(e => {
      incrementOutboxAttempt(e.id, withRequestRef(`HTTP ${res.status}: ${errText}`, res));
      trackIfNewlyDead(e);
    });
    return 0;
  }

  const result = await res.json() as {
    ok: string[];
    conflicts: Array<{ id: string; error?: string; code?: string }>;
  };

  markOutboxSynced(result.ok);

  // The server returns entries it could NOT apply in `conflicts`. Two kinds:
  //  - PERMANENT (an authorization denial): retrying can never help. Mark the
  //    entry denied (#202) instead of dropping OR dead-lettering it — a
  //    dead-lettered authz reject used to stay pending and pin the sync
  //    indicator on a write that would never be accepted (the known "stuck on
  //    N pending" symptom); an outright drop made the rejection invisible.
  //    Denied entries are excluded from every active/failed count (see
  //    outbox.ts) and surfaced separately with a human-readable message.
  //  - TRANSIENT (a bad column, an FK to a not-yet-synced row, a maintenance
  //    freeze): count the attempt and record the error so it's bounded by
  //    MAX_ATTEMPTS and visible. This preserves the prior behavior for these.
  // "reason" is the server's own short rejection message (already non-PII —
  // e.g. "Table not allowed", "Forbidden: teams requires manage_teams") — never
  // the synced row's field content. It is tracked for telemetry but NEVER
  // shown to the user — denialMessage() produces the user-facing text instead.
  const entryById = new Map(entries.map(e => [e.id, e]));
  for (const c of result.conflicts ?? []) {
    const e = entryById.get(c.id);
    if (isPermanentRejection(c.error, c.code)) {
      if (e) {
        // #235: the ref is appended even to the friendly denial message — it's
        // just a correlation id, not the raw server reason denialMessage()
        // deliberately withholds from the user.
        markOutboxDenied(c.id, withRequestRef(denialMessage({ table_name: e.table_name, operation: e.operation }), res));
        track('error', 'push_conflict', { props: { table: e.table_name, reason: c.error ?? 'Rejected by server', permanent: true } });
      } else {
        // Shouldn't happen — c.id came from the batch we just posted — but
        // without the entry's table/operation there's nothing to build a
        // denial message from. Fall back to the old outright-drop behavior
        // rather than leave an untraceable row stuck pending forever.
        dropOutboxEntry(c.id);
      }
      continue;
    }
    incrementOutboxAttempt(c.id, withRequestRef(c.error ? `Rejected: ${c.error}` : 'Rejected by server', res));
    if (e) {
      track('error', 'push_conflict', { props: { table: e.table_name, reason: c.error ?? 'Rejected by server' } });
      trackIfNewlyDead(e);
    }
  }

  // activity_log is push-only (never pulled back), so its rows' synced_at is
  // only cleared here. Reconcile against the outbox so pushed rows stop
  // showing "↑ pending" — and so rows stranded by older builds self-heal.
  reconcileLogSyncState();

  return result.ok?.length ?? 0;
}

async function drainOutbox(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const jwt = await getValidJwt();
    if (!jwt) return;

    const entries = getPendingOutbox(50).filter(e => e.attempts < MAX_ATTEMPTS);
    if (entries.length === 0) return;

    await pushEntries(entries, jwt);
  } catch (err) {
    // Network errors — will retry on next tick
    console.warn('[Sync] Outbox drain failed:', (err as Error).message);
  } finally {
    running = false;
  }
}

/**
 * Drains ONLY the pending activity_log rows and returns how many are still
 * undelivered (0 = the audit trail is safely on the server).
 *
 * Used by the demo-session handoff: entering a sandbox eventually wipes the local
 * DB, so the audit trail has to be pushed before the outgoing user's other pending
 * work is discarded. Callers MUST invoke this while the OUTGOING user's JWT is
 * still current — the API rejects writes from test accounts, so once the demo PIN
 * has replaced the session it is too late.
 *
 * Deliberately not routed through runDrainAndPull(): that path is gated on
 * isSandboxActive() (a guard for a LIVE demo session) and also pulls, which we
 * don't want here.
 */
export async function pushPendingLogs(): Promise<number> {
  // Re-arm dead log rows: without this, one entry that exhausted its retries
  // would block demo sign-in forever. A genuinely un-pushable row (an authz
  // rejection) is dropped by pushEntries, so this cannot loop indefinitely.
  retryFailedOutbox('activity_log');

  try {
    const jwt = await getValidJwt();
    // Fully signed out (rather than switching) — the logs cannot be pushed as
    // anyone. Report them as stuck; the caller tells the user to sign in first.
    if (!jwt) return getPendingLogCount();

    // Batch until the server stops accepting: a batch that delivers nothing new
    // means the rest are dead-lettered or rejected, so stop rather than spin.
    for (;;) {
      const entries = getPendingOutbox(50, 'activity_log').filter(e => e.attempts < MAX_ATTEMPTS);
      if (entries.length === 0) break;
      const delivered = await pushEntries(entries, jwt);
      if (delivered === 0) break;
    }
  } catch (err) {
    console.warn('[Sync] Activity log push failed:', (err as Error).message);
  }

  return getPendingLogCount();
}

async function syncCycle(): Promise<void> {
  // A cycle is running now, so any armed fast retry is redundant.
  if (fastRetryId) { clearTimeout(fastRetryId); fastRetryId = null; }

  // Always attempt the sync. We deliberately do NOT gate on NetInfo's
  // isConnected: it false-negatives on some Android networks/VPNs, which would
  // freeze background sync entirely (no error, just silently skipped — the
  // exact "sync stopped working" symptom). The fetch inside drain/pull is the
  // real source of truth: if we're genuinely offline it throws and is caught,
  // costing one cheap failed request per cycle. NetInfo still drives the
  // sync-on-reconnect listener in startSyncEngine (an optimization, not a gate).
  await runDrainAndPull();

  // Try immediately (above) but if anything is still undelivered — offline,
  // a push error, or leftover entries — retry in ~10s instead of waiting for
  // the 60s heartbeat. Once the outbox drains, this stops arming itself.
  if (hasDeliverableWork()) scheduleFastRetry();

  // #236: one telemetry heartbeat per completed cycle (throttled/gated —
  // see emitOutboxHeartbeat), after the drain/pull attempt so it reflects
  // this cycle's outcome rather than the pre-cycle state.
  emitOutboxHeartbeat();
}

// The actual network work: drain the outbox, then pull. Errors are caught so a
// transient failure never escapes; offline simply throws inside the fetch and
// is swallowed here.
async function runDrainAndPull(): Promise<void> {
  // Test/demo sessions are fully sandboxed: no push (throwaway edits must never
  // reach the server) and no pull (INSERT OR REPLACE would clobber the sandbox
  // edits mid-demo). Single choke point — covers the heartbeat, reconnect,
  // foreground, fast-retry, and user-initiated syncNow paths alike.
  if (isSandboxActive()) return;
  try {
    await drainOutbox();
    await pullChanges();
    // Incremental pull is upsert-only and never deletes. Once teams are scoped
    // server-side, a team the user was REMOVED from simply stops being returned —
    // nothing tells this device to forget it. Reconcile every sync, not once.
    await reconcileTeams();
    // Same upsert-only hole for chat: a conversation the user was removed from
    // stops being returned but never leaves the device without this.
    await reconcileChat();
    // A pull may have changed product_class units/decimals — refresh the cache
    // that formatQuantity() reads so quantities reflect the latest config.
    loadClassConfigCache();
    // A pull may also have changed role_settings.permission_overrides — refresh
    // the role-override cache that hasPermission() reads.
    loadRolePermissionCache();
    // A pull may also have changed dashboard_presets or the per-user/role
    // assignment — refresh the cache the hub's useDashboardLayout() reads.
    loadDashboardCache();
    // A pull may also have delivered new messages / read receipts — refresh the
    // total-unread cache the ChatBell + dashboard chat tile read.
    void getSavedUserId().then(id => { if (id) loadChatCache(id); });
    // A pull may also have changed app_config hidden_fields — notify subscribers
    // so HidableField components re-render without waiting for a focus event.
    notifyHiddenFieldsChanged();
    notifyUnitAccessDefaultsChanged();
    // A pull may also have changed the org default theme (app_config
    // 'default_theme_id') — silently re-theme users who never picked their own
    // (no prompt: they never chose, so following the org default is the intent),
    // then run the personal-theme prompt path for users who did.
    void getSavedUserId().then(id => {
      applyOrgDefaultTheme(id ?? null);
      if (id) applyUserTheme(id, { prompt: true });
    });
    // Fire-and-forget local alert checks (low stock / temp-employee expiry).
    // It swallows its own errors and resolves void, so it can't disturb the
    // existing try/catch/return behaviour of this cycle.
    void runLocalAlertChecks();
    // Fire-and-forget thumbnail warm-up for media rows that arrived since the
    // last prefetch. Runs every cycle (even empty pulls) so a >batch backlog
    // drains over subsequent cycles; bounded, self-swallowing, never blocks.
    void prefetchNewMediaThumbnails();
    // Fire-and-forget telemetry flush — rides the same ~60s cadence + the
    // reconnect/foreground triggers as the rest of this cycle. Deliberately
    // NOT part of the /sync/push request: its own transport, its own
    // endpoint, never blocks or fails the business sync.
    flushTelemetry().catch(() => {});
  } catch (err) {
    console.warn('[Sync] Cycle error:', (err as Error).message);
  }
}

export async function syncNow(): Promise<void> {
  // User-initiated (Settings "Sync now" / pull-to-refresh). Do NOT gate on
  // NetInfo: its isConnected can false-negative on some Android networks/VPNs,
  // which would silently skip the sync and make pull-to-refresh appear broken.
  // Just attempt the network — the fetch fails fast and harmlessly if we really
  // are offline. drainOutbox/pullChanges each no-op without a valid session.
  await runDrainAndPull();
  if (hasDeliverableWork()) scheduleFastRetry();
}

export function startSyncEngine(): void {
  if (started) return;
  started = true;

  // NetInfo: sync on reconnect
  netInfoUnsub = NetInfo.addEventListener(state => {
    if (state.isConnected) {
      syncCycle();
    }
  });

  // AppState: sync when app comes to foreground
  const handleAppState = (nextState: AppStateStatus) => {
    if (nextState === 'active') {
      syncCycle();
    }
  };
  const subscription = AppState.addEventListener('change', handleAppState);
  appStateUnsub = () => subscription.remove();

  // Periodic drain every 60s
  intervalId = setInterval(syncCycle, INTERVAL_MS);

  // Initial sync
  syncCycle();
}

export function stopSyncEngine(): void {
  if (netInfoUnsub) { netInfoUnsub(); netInfoUnsub = null; }
  if (appStateUnsub) { appStateUnsub(); appStateUnsub = null; }
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
  if (fastRetryId) { clearTimeout(fastRetryId); fastRetryId = null; }
  started = false;
}
