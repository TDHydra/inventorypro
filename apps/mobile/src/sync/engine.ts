import NetInfo from '@react-native-community/netinfo';
import { AppState, AppStateStatus } from 'react-native';
import { getPendingOutbox, markOutboxSynced, incrementOutboxAttempt, OutboxEntry } from './outbox';
import { pullChanges } from './pull';
import { reconcileLogSyncState } from '../db/queries/log';
import { getValidJwt } from '../auth/session';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const MAX_ATTEMPTS = 5;
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
      entries.forEach(e => incrementOutboxAttempt(e.id, `HTTP ${res.status}: ${errText}`));
      return;
    }

    const result = await res.json() as {
      ok: string[];
      conflicts: Array<{ id: string; error?: string }>;
    };

    markOutboxSynced(result.ok);

    // The server returns entries it could NOT apply (e.g. a bad column or an
    // FK to a not-yet-synced row) in `conflicts`. Previously these were dropped
    // silently — they stayed pending at attempts=0 and were re-sent every cycle
    // forever, keeping the indicator stuck with no diagnostic. Count the attempt
    // and record the error so they're bounded by MAX_ATTEMPTS and visible.
    for (const c of result.conflicts ?? []) {
      incrementOutboxAttempt(c.id, c.error ? `Rejected: ${c.error}` : 'Rejected by server');
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
  try {
    await drainOutbox();
    await pullChanges();
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
