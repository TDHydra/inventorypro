// src/sync/netinfo.ts — native re-export of the real NetInfo package.
// Metro resolves this to netinfo.web.ts on web (navigator.onLine shim).
export { default } from '@react-native-community/netinfo';
