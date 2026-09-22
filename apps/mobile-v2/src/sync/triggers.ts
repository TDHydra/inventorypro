// SyncTriggers implementation for the app: fire an immediate sync cycle when
// connectivity returns or the app foregrounds. Injected into core's
// startSyncEngine() so the engine itself stays free of NetInfo/AppState
// imports (and therefore node:test-able). Metro resolves ./netinfo to the
// navigator.onLine shim on web, where AppState is a no-op 'active' constant.
import { AppState } from 'react-native';
import type { SyncTriggers } from '@invenpro/core';
import NetInfo from './netinfo';

export const appSyncTriggers: SyncTriggers = fire => {
  const unsubNet = NetInfo.addEventListener(state => {
    if (state.isConnected) fire();
  });
  const appStateSub = AppState.addEventListener('change', next => {
    if (next === 'active') fire();
  });
  return () => {
    unsubNet();
    appStateSub.remove();
  };
};
