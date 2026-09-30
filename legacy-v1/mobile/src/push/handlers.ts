import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { appSyncSheetBus } from '../components/syncSheetBus';
import { useSession } from '../hooks/useSession';
import { sendMessage, markConversationRead } from '../db/queries/chat';
import { loadChatCache } from '../chat/store';
import { isWriteBlocked } from '../db/maintenance';
import { syncNow } from '../sync/engine';
import { track } from '../telemetry';
import { resolveNotificationAction, CHAT_CATEGORY_ID } from './notificationActions';

// NOTE: the foreground presentation handler (setNotificationHandler) is
// already configured by `../notifications/localAlerts` (imported from
// _layout.tsx), which shows a banner + sound for ANY incoming notification —
// local scheduled alerts and remote Expo push alike, since expo-notifications
// treats both the same way once they land in JS. Re-declaring it here would
// just overwrite that identical global singleton, so this module deliberately
// leaves it untouched and only adds tap/response (deep-link) handling, which
// is push-specific and has no local-alerts equivalent today.

type Router = ReturnType<typeof useRouter>;

// Minimal screen → route dispatch for the push foundation. Real notification
// types (#2-#5) will extend this switch as they're built; an unrecognized or
// missing `screen` falls back to the dashboard rather than doing nothing.
// Routes navigated with the literal pathname/params shape used elsewhere in
// the app (see ItemCard.tsx) so expo-router's generated typed-routes accept
// each call directly.
function navigateToPayload(router: Router, data: Record<string, unknown> | undefined): void {
  const screen = typeof data?.screen === 'string' ? data.screen : undefined;
  const id = typeof data?.id === 'string' ? data.id : undefined;

  switch (screen) {
    case 'jobs':
      if (id) router.push({ pathname: '/(app)/(jobs)/[id]', params: { id } });
      else router.push('/(app)/(jobs)');
      return;
    case 'inventory':
      if (id) router.push({ pathname: '/(app)/(inventory)/[id]', params: { id } });
      else router.push('/(app)/(inventory)');
      return;
    case 'repairs':
      if (id) router.push({ pathname: '/(app)/(repairs)/[id]', params: { id } });
      else router.push('/(app)/(repairs)');
      return;
    case 'chat': {
      const conversationId = typeof data?.conversationId === 'string' ? data.conversationId : id;
      if (conversationId) router.push({ pathname: '/(app)/(chat)/[id]', params: { id: conversationId } });
      else router.push('/(app)/(chat)');
      return;
    }
    case 'media':
      // #87: pool photo share — open the media hub on the shared photo.
      if (id) router.push({ pathname: '/(app)/(media)', params: { id } });
      else router.push('/(app)/(media)');
      return;
    case 'schedule':
      // #230: schedule-change push lands on the schedule board.
      router.push('/(app)/(schedule)');
      return;
    case 'notifications':
      // broadcast / approval / checkout-idle pushes open the in-app inbox
      router.push('/(app)/(notifications)');
      return;
    case 'sync':
      // #205 sync-stuck local alert: land on the dashboard, then ask the
      // SyncIndicator (mounted in the app header) to open its sheet. The bus
      // holds the request if the tap arrives before the indicator mounts
      // (cold start straight from the notification).
      router.push('/(app)/(dashboard)');
      appSyncSheetBus.requestOpen();
      return;
    case 'dashboard':
    default:
      router.push('/(app)/(dashboard)');
      return;
  }
}

/**
 * Wires the notification-tap → deep-link path. Call once from the root layout
 * (inside the session provider, so `useRouter` is available). Cleans up its
 * listener on unmount.
 */
export function useNotificationObservers(): void {
  const router = useRouter();
  const { user } = useSession();
  const userId = user?.id ?? null;

  // #231: register the chat quick-action category. Idempotent (re-registering
  // the same id just replaces it), so re-running on remount is harmless. The
  // category is referenced by categoryId on the server's chat pushes; both
  // actions run without foregrounding the app.
  useEffect(() => {
    void Notifications.setNotificationCategoryAsync(CHAT_CATEGORY_ID, [
      {
        identifier: 'chat-reply',
        buttonTitle: 'Reply',
        textInput: { submitButtonTitle: 'Send', placeholder: 'Reply…' },
        options: { opensAppToForeground: false },
      },
      {
        identifier: 'chat-mark-read',
        buttonTitle: 'Mark read',
        options: { opensAppToForeground: false },
      },
    ]).catch(() => { /* categories unsupported (web) — plain taps still work */ });
  }, []);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      try {
        const data = response.notification.request.content.data as Record<string, unknown> | undefined;
        const action = resolveNotificationAction(
          response.actionIdentifier,
          Notifications.DEFAULT_ACTION_IDENTIFIER,
          data,
          response.userText,
        );
        // #231: quick actions write locally + queue through the outbox like any
        // other chat write; blocked writes (maintenance / preview-as-role) fall
        // back to opening the conversation instead of silently dropping input.
        if (action.kind === 'chat-reply' && userId && !isWriteBlocked()) {
          sendMessage(action.conversationId, userId, action.text);
          markConversationRead(action.conversationId, userId);
          loadChatCache(userId);
          track('action', 'chat_quick_reply', { screen: 'notification' });
          void syncNow().catch(() => { /* offline — outbox syncs later */ });
          return;
        }
        if (action.kind === 'chat-mark-read' && userId && !isWriteBlocked()) {
          markConversationRead(action.conversationId, userId);
          loadChatCache(userId);
          track('action', 'chat_quick_mark_read', { screen: 'notification' });
          void syncNow().catch(() => { /* offline — outbox syncs later */ });
          return;
        }
        navigateToPayload(router, data);
      } catch {
        /* malformed notification payload — never crash the app over a deep-link */
      }
    });
    return () => subscription.remove();
  }, [router, userId]);
}
