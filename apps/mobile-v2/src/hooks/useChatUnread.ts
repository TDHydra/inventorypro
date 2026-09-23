import { useSyncExternalStore } from 'react';
import { chatUnreadCache } from '../chat/unread';

/** Reactive total-unread count for the header ChatBell — re-renders on any
 * local mark-as-read/leave (via reloadChatUnread()) or sync pull touching
 * messages/conversation_participants (the cache's own afterPull hook). */
export function useChatUnread(): number {
  return useSyncExternalStore(chatUnreadCache.subscribe, chatUnreadCache.get, chatUnreadCache.get);
}
