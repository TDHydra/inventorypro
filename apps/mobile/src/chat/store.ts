import { useSyncExternalStore } from 'react';
import { totalUnread } from '../db/queries/chat';

// Reactive total-unread cache for chat, mirroring the role-permission cache in
// src/auth/permissions.ts and the dashboard cache in src/dashboard/store.ts.
// A badge/header reads useTotalUnread() and re-renders when loadChatCache() runs.
// Wired at boot (app/_layout.tsx) and post-pull (src/sync/engine.ts) alongside the
// other loadXCache() calls; the chat screens also refresh it on their own writes.

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
// existing value in place. Only notifies when the count actually changed, so the
// ChatBell's 4s interval doesn't re-render every subscriber (e.g. the dashboard)
// on an unchanged value.
export function loadChatCache(userId: string | null | undefined): void {
  let next = unread;
  try {
    next = userId ? totalUnread(userId) : 0;
  } catch {
    // DB not initialized / table missing — keep whatever we have.
  }
  if (next === unread) return;
  unread = next;
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
