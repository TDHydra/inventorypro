import { AppState } from 'react-native';
import NetInfo from './netinfo';
import { noteNetInfoState } from './connectivityStore';

// #215 feedback: the banner must appear the moment the network drops, not
// whenever NetInfo's push event gets around to firing (observed lagging by
// several seconds on device). Glue installed once at the root layout next to
// startSyncEngine, lives for the app's lifetime.
//
// Three feeds into connectivityStore:
//  - NetInfo push events (the pre-existing signal),
//  - a fast NetInfo.fetch() poll — a local system-state read, NOT a network
//    probe, so polling it aggressively is cheap. Only while the app is
//    foregrounded: a backgrounded app has no banner to update.
//  - a probe on foreground, so the state is fresh the instant the app returns.

const POLL_MS = 2500;

let installed = false;

export function installConnectivityMonitor(): void {
  if (installed) return;
  installed = true;

  NetInfo.addEventListener(state => noteNetInfoState(state.isConnected));

  const probe = () => {
    NetInfo.fetch().then(
      state => noteNetInfoState(state.isConnected),
      () => { /* system read failed — keep the last known state */ },
    );
  };

  setInterval(() => {
    if (AppState.currentState === 'active') probe();
  }, POLL_MS);

  AppState.addEventListener('change', next => {
    if (next === 'active') probe();
  });

  probe();
}
