import NetInfo from '@react-native-community/netinfo';
import { AppState, AppStateStatus } from 'react-native';
import { getPendingOutbox, markOutboxSynced, incrementOutboxAttempt, OutboxEntry } from './outbox';
import { pullChanges } from './pull';
import { getValidJwt } from '../auth/session';

const API_BASE = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000';
const MAX_ATTEMPTS = 5;
const INTERVAL_MS = 60_000;

let running = false;
let intervalId: ReturnType<typeof setInterval> | null = null;
let netInfoUnsub: (() => void) | null = null;
let appStateUnsub: (() => void) | null = null;

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
      conflicts: Array<{ id: string; resolution: Record<string, unknown> }>;
    };

    markOutboxSynced(result.ok);

    // Apply conflict resolutions to local DB
    // (pull.ts handles the full merge; conflicts here are rare)
  } catch (err) {
    // Network errors — will retry on next tick
    console.warn('[Sync] Outbox drain failed:', (err as Error).message);
  } finally {
    running = false;
  }
}

async function syncCycle(): Promise<void> {
  const state = await NetInfo.fetch();
  if (!state.isConnected) return;

  try {
    await drainOutbox();
    await pullChanges();
  } catch (err) {
    console.warn('[Sync] Cycle error:', (err as Error).message);
  }
}

export function startSyncEngine(): void {
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
}
