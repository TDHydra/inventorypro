// #231: pure resolution of a notification response into an app action —
// quick-reply / mark-read on chat pushes, navigate for everything else.
// DB/React/expo-free so node tests cover the decision table directly.

// Category id stamped on chat pushes by the API (lib/push.ts buildMessages
// callers) and registered on-device in handlers.ts. Changing it breaks
// action buttons on already-sent notifications — treat as a wire constant.
export const CHAT_CATEGORY_ID = 'chat-message';

export type ResolvedNotificationAction =
  | { kind: 'navigate' }
  | { kind: 'chat-reply'; conversationId: string; text: string }
  | { kind: 'chat-mark-read'; conversationId: string };

export function resolveNotificationAction(
  actionIdentifier: string | null | undefined,
  defaultActionId: string,
  data: Record<string, unknown> | undefined,
  userText?: string,
): ResolvedNotificationAction {
  const conversationId =
    typeof data?.conversationId === 'string' && data.conversationId ? data.conversationId : null;
  if (!actionIdentifier || actionIdentifier === defaultActionId || !conversationId) {
    return { kind: 'navigate' };
  }
  if (actionIdentifier === 'chat-reply') {
    const text = (userText ?? '').trim();
    // Blank inline reply → just open the chat instead of sending nothing.
    return text ? { kind: 'chat-reply', conversationId, text } : { kind: 'navigate' };
  }
  if (actionIdentifier === 'chat-mark-read') {
    return { kind: 'chat-mark-read', conversationId };
  }
  return { kind: 'navigate' };
}
