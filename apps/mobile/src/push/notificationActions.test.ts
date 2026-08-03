import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveNotificationAction, CHAT_CATEGORY_ID } from './notificationActions';

const DEFAULT = 'expo.modules.notifications.actions.DEFAULT';
const chatData = { screen: 'chat', conversationId: 'c1' };

test('category id is stable (server payloads reference it)', () => {
  assert.equal(CHAT_CATEGORY_ID, 'chat-message');
});

test('plain tap (default action) navigates', () => {
  assert.deepEqual(
    resolveNotificationAction(DEFAULT, DEFAULT, chatData, undefined),
    { kind: 'navigate' },
  );
});

test('reply with text becomes a chat-reply, trimmed', () => {
  assert.deepEqual(
    resolveNotificationAction('chat-reply', DEFAULT, chatData, '  on my way  '),
    { kind: 'chat-reply', conversationId: 'c1', text: 'on my way' },
  );
});

test('reply with blank text falls back to navigate', () => {
  assert.deepEqual(
    resolveNotificationAction('chat-reply', DEFAULT, chatData, '   '),
    { kind: 'navigate' },
  );
});

test('mark-read action resolves with the conversation id', () => {
  assert.deepEqual(
    resolveNotificationAction('chat-mark-read', DEFAULT, chatData, undefined),
    { kind: 'chat-mark-read', conversationId: 'c1' },
  );
});

test('chat action without a conversation id navigates', () => {
  assert.deepEqual(
    resolveNotificationAction('chat-reply', DEFAULT, { screen: 'chat' }, 'hi'),
    { kind: 'navigate' },
  );
});

test('unknown action identifier navigates', () => {
  assert.deepEqual(
    resolveNotificationAction('some-future-action', DEFAULT, chatData, undefined),
    { kind: 'navigate' },
  );
});
