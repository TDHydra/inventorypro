import { useSyncExternalStore } from 'react';
import { totalUnread } from '../db/queries/chat';

// Reactive total-unread cache for chat, mirroring the role-permission cache in
// src/auth/permissions.ts and the dashboard cache in src/dashboard/store.ts.
// A badge/header reads useTotalUnread() and re-renders when loadChatCache() runs.
//
// WIRING NOTE: the other caches (loadRolePermissionCache / loadDashboardCache) are
// invoked at boot and after every sync in app/_layout.tsx + src/sync/engine.ts.
// Those files are owned by another agent, so this loader is intentionally exposed
// but NOT wired there yet. TODO(chat): call loadChatCache(currentUserId) alongside
// the other loadXCache() calls at boot + post-pull. Until then the chat screens
// refresh it themselves on focus + on a useDataVersion() bump, so counts stay live.

let unread = 0;
let cacheVersion = 0;
const listeners = new Set<() => void>();

export function subscribeChat(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getChatVersion(): number {
  return cacheVersion;
}

// Recompute the cached total-unread count for `userId` from the local DB. Safe to
// call before the DB is ready (or before migration 034) — failures leave the
// existing value in place. Always bumps the version + notifies subscribers.
export function loadChatCache(userId: string | null | undefined): void {
  try {
    unread = userId ? totalUnread(userId) : 0;
  } catch {
    // DB not initialized / table missing — keep whatever we have.
  }
  cacheVersion++;
  listeners.forEach(l => l());
}

export function getTotalUnread(): number {
  return unread;
}

// Hook: re-renders when the chat cache changes (message sent/read/synced) via
// useSyncExternalStore, then returns the cached total unread. Mirrors
// usePermission / useDashboardLayout.
export function useTotalUnread(): number {
  useSyncExternalStore(subscribeChat, getChatVersion, getChatVersion);
  return unread;
}
