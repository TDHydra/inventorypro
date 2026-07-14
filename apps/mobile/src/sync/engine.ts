import NetInfo from './netinfo';
import { AppState, AppStateStatus } from 'react-native';
import { getPendingOutbox, markOutboxSynced, incrementOutboxAttempt, dropOutboxEntry, OutboxEntry, MAX_OUTBOX_ATTEMPTS } from './outbox';
import { pullChanges } from './pull';
import { isSandboxActive } from './sandbox';
import { reconcileTeams } from './teamPurge';
import { reconcileLogSyncState } from '../db/queries/log';
import { getValidJwt } from '../auth/session';
import { loadClassConfigCache } from '../constants/units';
import { loadRolePermissionCache } from '../auth/permissions';
import { loadDashboardCache } from '../dashboard/store';
import { notifyHiddenFieldsChanged } from '../db/hiddenFields';
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

// A server conflict is PERMANENT when retrying can never make it succeed: an
// authorization denial. The /sync/push handler surfaces these as conflict
// messages containing 'Forbidden' / 'cannot' / 'not allowed' (apps/api/src/routes/
// sync.ts — e.g. 'Forbidden: teams requires manage_teams', 'Table not allowed').
// Everything else — the generic 'write rejected' (masks a bad column or an FK to a
// not-yet-synced row) and 'Maintenance mode: writes are frozen' (succeeds once the
// freeze lifts) — is treated as TRANSIENT and retried, bounded by MAX_ATTEMPTS.
// Deliberately conservative: only these three phrases classify as permanent, so an
// unrecognized rejection defaults to today's retry-then-dead-letter behavior.
const PERMANENT_REJECTION = /forbidden|cannot|not allowed/i;
function isPermanentRejection(error?: string): boolean {
  return !!error && PERMANENT_REJECTION.test(error);
}

async function drainOutbox(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const jwt = await getValidJwt();
    if (!jwt) return;

    const entries = getPendingOutbox(50).filter(e => e.attempts < MAX_ATTEMPTS);
    if (entries.length === 0) return;

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
        incrementOutboxAttempt(e.id, `HTTP ${res.status}: ${errText}`);
        trackIfNewlyDead(e);
      });
      return;
    }

    const result = await res.json() as {
      ok: string[];
      conflicts: Array<{ id: string; error?: string }>;
    };

    markOutboxSynced(result.ok);

    // The server returns entries it could NOT apply in `conflicts`. Two kinds:
    //  - PERMANENT (an authorization denial): retrying can never help. Drop the
    //    entry now instead of dead-lettering it — a dead-lettered authz reject
    //    stays pending and pins the sync indicator on a write that will never be
    //    accepted (the known "stuck on N pending" symptom).
    //  - TRANSIENT (a bad column, an FK to a not-yet-synced row, a maintenance
    //    freeze): count the attempt and record the error so it's bounded by
    //    MAX_ATTEMPTS and visible. This preserves the prior behavior for these.
    // "reason" is the server's own short rejection message (already non-PII —
    // e.g. "Table not allowed", "Forbidden: teams requires manage_teams") — never
    // the synced row's field content.
    const entryById = new Map(entries.map(e => [e.id, e]));
    for (const c of result.conflicts ?? []) {
      const e = entryById.get(c.id);
      if (isPermanentRejection(c.error)) {
        dropOutboxEntry(c.id);
        if (e) {
          track('error', 'push_conflict', { props: { table: e.table_name, reason: c.error ?? 'Rejected by server', permanent: true } });
        }
        continue;
      }
      incrementOutboxAttempt(c.id, c.error ? `Rejected: ${c.error}` : 'Rejected by server');
      if (e) {
        track('error', 'push_conflict', { props: { table: e.table_name, reason: c.error ?? 'Rejected by server' } });
        trackIfNewlyDead(e);
      }
    }

    // activity_log is push-only (never pulled back), so its rows' synced_at is
    // only cleared here. Reconcile against the outbox so pushed rows stop
    // showing "↑ pending" — and so rows stranded by older builds self-heal.
    reconcileLogSyncState();
  } catch (err) {
    // Network errors — will retry on next tick
    console.warn('[Sync] Outbox drain failed:', (err as Error).message);
  } finally {
    running = false;
  }
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
    // A pull may have changed product_class units/decimals — refresh the cache
    // that formatQuantity() reads so quantities reflect the latest config.
    loadClassConfigCache();
    // A pull may also have changed role_settings.permission_overrides — refresh
    // the role-override cache that hasPermission() reads.
    loadRolePermissionCache();
    // A pull may also have changed dashboard_presets or the per-user/role
    // assignment — refresh the cache the hub's useDashboardLayout() reads.
    loadDashboardCache();
    // A pull may also have changed app_config hidden_fields — notify subscribers
    // so HidableField components re-render without waiting for a focus event.
    notifyHiddenFieldsChanged();
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
