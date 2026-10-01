// Render + interaction tests for the chat thread route (an `[id]` screen).
// Conversations/participants/messages are real seeded rows; sends and edits are
// asserted by reading back what the screen wrote to the messages table.
import type { ReactElement } from 'react';
import { screen, fireEvent, act } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb, getDb } from '../../../test/pageTestDb';
import { navCalls, setRouteParams, stackScreenOptions } from '../../../test/mocks/expoRouter';
import { chatUnreadCache, setChatCurrentUserId } from '../../../src/chat/unread';
import ChatThreadScreen from './[id]';

const TS = '2026-01-01T00:00:00Z';
const ME = 'user-1';

function seedUser(id: string, name: string, role = 'construction_crew') {
  seed('users', {
    id, name, role, pin_length_required: 4, permission_overrides: '{}',
    active: 1, created_at: TS, updated_at: TS,
  });
}

function seedConversation(
  id: string, kind: 'dm' | 'group', members: string[], extra: Record<string, unknown> = {},
) {
  seed('conversations', { id, kind, created_by: ME, created_at: TS, updated_at: TS, ...extra });
  for (const uid of members) {
    seed('conversation_participants', {
      conversation_id: id, user_id: uid, notify_pref: 'all', added_at: TS, updated_at: TS,
    });
  }
}

let msgSeq = 0;
function seedMessage(
  conversationId: string, senderId: string, body: string, at: string, extra: Record<string, unknown> = {},
) {
  const id = `m-${++msgSeq}`;
  seed('messages', {
    id, conversation_id: conversationId, sender_id: senderId, body,
    urgency: 'regular', created_at: at, updated_at: at, ...extra,
  });
  return id;
}

function messageRows() {
  return getDb().executeSync(`SELECT * FROM messages ORDER BY created_at`).rows as Array<{
    id: string; body: string; urgency: string; sender_id: string; edited_at: string | null; deleted_at: string | null;
  }>;
}

// "Details" lives in <Stack.Screen options.headerRight>, which the router mock
// records rather than renders — so press it through the declared element.
async function pressHeaderDetails() {
  const opts = [...stackScreenOptions].reverse().find(o => typeof o.headerRight === 'function');
  const el = (opts!.headerRight as () => ReactElement)();
  await act(async () => { (el.props as { onPress: () => void }).onPress(); });
}

beforeEach(async () => {
  await initPageDb();
  msgSeq = 0;
  seedUser(ME, 'Dev Tester', 'full_admin');
  seedUser('user-bob', 'Bob Builder');
  seedUser('user-cy', 'Cy Carpenter');
});

test('renders a DM thread with its messages and the peer name as the title', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  seedMessage('c1', 'user-bob', 'Truck is loaded', '2026-01-02T10:00:00Z');
  seedMessage('c1', ME, 'On my way', '2026-01-02T10:01:00Z');
  setRouteParams({ id: 'c1' });
  await renderScreen(<ChatThreadScreen />);

  expect(screen.getByText('Truck is loaded')).toBeOnTheScreen();
  expect(screen.getByText('On my way')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Bob Builder', headerShown: true }),
  );
});

test('shows the empty-thread prompt when a conversation has no messages', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  setRouteParams({ id: 'c1' });
  await renderScreen(<ChatThreadScreen />);
  expect(screen.getByText('No messages yet. Say hello 👋')).toBeOnTheScreen();
});

test('renders the dead-end screen when the conversation does not exist', async () => {
  setRouteParams({ id: 'does-not-exist' });
  await renderScreen(<ChatThreadScreen />);

  expect(screen.getByText('This conversation is no longer available')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Chat' }));
  // No composer on the dead-end.
  expect(screen.queryByPlaceholderText('Message…')).not.toBeOnTheScreen();

  await fireEvent.press(screen.getByText('Back to messages'));
  expect(navCalls).toContainEqual({ method: 'back', args: [] });
});

test('does not show messages from other conversations', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  seedConversation('c2', 'dm', [ME, 'user-cy']);
  seedMessage('c1', 'user-bob', 'in this thread', '2026-01-02T10:00:00Z');
  seedMessage('c2', 'user-cy', 'in the other thread', '2026-01-02T10:00:00Z');
  setRouteParams({ id: 'c1' });
  await renderScreen(<ChatThreadScreen />);

  expect(screen.getByText('in this thread')).toBeOnTheScreen();
  expect(screen.queryByText('in the other thread')).not.toBeOnTheScreen();
});

test('shows sender names in a group, deleted placeholders, and the edited marker', async () => {
  seedConversation('g1', 'group', [ME, 'user-bob', 'user-cy'], { title: 'Crew Alpha' });
  seedMessage('g1', 'user-bob', 'ladder is on the roof', '2026-01-02T10:00:00Z');
  seedMessage('g1', 'user-cy', 'retracted text', '2026-01-02T10:01:00Z', { deleted_at: '2026-01-02T10:02:00Z' });
  seedMessage('g1', ME, 'got it', '2026-01-02T10:03:00Z', { edited_at: '2026-01-02T10:04:00Z' });
  setRouteParams({ id: 'g1' });
  await renderScreen(<ChatThreadScreen />);

  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Crew Alpha' }));
  expect(screen.getByText('Bob Builder')).toBeOnTheScreen(); // sender label, groups only
  expect(screen.getByText('Message deleted')).toBeOnTheScreen();
  expect(screen.queryByText('retracted text')).not.toBeOnTheScreen();
  expect(screen.getByText('(edited)')).toBeOnTheScreen();
});

test('marks the conversation read on open', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  seedMessage('c1', 'user-bob', 'ping', '2026-01-02T10:00:00Z');
  setRouteParams({ id: 'c1' });
  await renderScreen(<ChatThreadScreen />);

  const row = getDb().executeSync(
    `SELECT last_read_at FROM conversation_participants WHERE conversation_id = 'c1' AND user_id = ?`, [ME],
  ).rows[0] as { last_read_at: string | null };
  expect(row.last_read_at).not.toBeNull();
});

test('the Send button does nothing until there is text, then sends and clears the composer', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  setRouteParams({ id: 'c1' });
  await renderScreen(<ChatThreadScreen />);

  await fireEvent.press(screen.getByText('Send'));
  expect(messageRows()).toHaveLength(0);

  await fireEvent.changeText(screen.getByPlaceholderText('Message…'), '  Need more shingles  ');
  await fireEvent.press(screen.getByText('Send'));

  const rows = messageRows();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ body: 'Need more shingles', sender_id: ME, urgency: 'urgent' });
  expect(screen.getByPlaceholderText('Message…').props.value).toBe('');
  // The new message re-renders into the list through useDbQuery.
  expect(screen.getByText('Need more shingles')).toBeOnTheScreen();
});

test('the Regular toggle sends the message as non-urgent', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  setRouteParams({ id: 'c1' });
  await renderScreen(<ChatThreadScreen />);

  await fireEvent.press(screen.getByText('Regular'));
  await fireEvent.changeText(screen.getByPlaceholderText('Message…'), 'no rush');
  await fireEvent.press(screen.getByText('Send'));

  expect(messageRows()[0]).toMatchObject({ body: 'no rush', urgency: 'regular' });
});

test('a non-participant cannot send (the composer silently drops the message)', async () => {
  // Admin opens a conversation they are not a member of.
  seedConversation('c-other', 'dm', ['user-bob', 'user-cy']);
  setRouteParams({ id: 'c-other' });
  await renderScreen(<ChatThreadScreen />);

  await fireEvent.changeText(screen.getByPlaceholderText('Message…'), 'hello?');
  await fireEvent.press(screen.getByText('Send'));
  expect(messageRows()).toHaveLength(0);
});

test('long-pressing my own message offers Edit, and saving updates the body', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  seedMessage('c1', ME, 'typo mesage', '2026-01-02T10:00:00Z');
  setRouteParams({ id: 'c1' });
  await renderScreen(<ChatThreadScreen />);

  await fireEvent(screen.getByText('typo mesage'), 'longPress');
  await fireEvent.press(screen.getByText('✏️ Edit'));

  expect(screen.getByText('Editing message')).toBeOnTheScreen();
  expect(screen.getByPlaceholderText('Message…').props.value).toBe('typo mesage');

  await fireEvent.changeText(screen.getByPlaceholderText('Message…'), 'typo message');
  await fireEvent.press(screen.getByText('Save'));

  const rows = messageRows();
  expect(rows).toHaveLength(1);
  expect(rows[0].body).toBe('typo message');
  expect(rows[0].edited_at).not.toBeNull();
  expect(screen.queryByText('Editing message')).not.toBeOnTheScreen();
});

test('long-pressing my own message and choosing Delete soft-deletes it', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  seedMessage('c1', ME, 'oops wrong chat', '2026-01-02T10:00:00Z');
  setRouteParams({ id: 'c1' });
  await renderScreen(<ChatThreadScreen />);

  await fireEvent(screen.getByText('oops wrong chat'), 'longPress');
  await fireEvent.press(screen.getByText('🗑 Delete'));

  expect(messageRows()[0].deleted_at).not.toBeNull();
  expect(screen.getByText('Message deleted')).toBeOnTheScreen();
});

test('someone else\'s message has no action menu (long-press is disabled)', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  seedMessage('c1', 'user-bob', 'not yours', '2026-01-02T10:00:00Z');
  setRouteParams({ id: 'c1' });
  await renderScreen(<ChatThreadScreen />);

  await fireEvent(screen.getByText('not yours'), 'longPress');
  expect(screen.queryByText('✏️ Edit')).not.toBeOnTheScreen();
  expect(screen.queryByText('🗑 Delete')).not.toBeOnTheScreen();
});

test('prefills the composer from the draft route param without sending it', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  setRouteParams({ id: 'c1', draft: 'Can I get access to this?' });
  await renderScreen(<ChatThreadScreen />);

  expect(screen.getByPlaceholderText('Message…').props.value).toBe('Can I get access to this?');
  expect(messageRows()).toHaveLength(0);
});

test('shows a "Read" receipt under my latest message once the peer has read it', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  seedMessage('c1', ME, 'did you see this', '2026-01-02T10:00:00Z');
  getDb().executeSync(
    `UPDATE conversation_participants SET last_read_at = ? WHERE conversation_id = 'c1' AND user_id = 'user-bob'`,
    ['2026-01-02T10:05:00Z'],
  );
  setRouteParams({ id: 'c1' });
  await renderScreen(<ChatThreadScreen />);

  expect(screen.getByText('Read')).toBeOnTheScreen();
});

test('the Details sheet lists members and Leave removes me and navigates back', async () => {
  seedConversation('g1', 'group', [ME, 'user-bob', 'user-cy'], { title: 'Crew Alpha' });
  setRouteParams({ id: 'g1' });
  await renderScreen(<ChatThreadScreen />);

  await pressHeaderDetails();
  expect(screen.getByText('Members (3)')).toBeOnTheScreen();
  expect(screen.getByText('Dev Tester (you)')).toBeOnTheScreen();
  // Group admins/members can remove others, never themselves.
  expect(screen.getAllByText('Remove')).toHaveLength(2);

  await fireEvent.press(screen.getByText('Leave conversation'));
  const mine = getDb().executeSync(
    `SELECT 1 FROM conversation_participants WHERE conversation_id = 'g1' AND user_id = ?`, [ME],
  ).rows;
  expect(mine).toHaveLength(0);
  expect(navCalls).toContainEqual({ method: 'back', args: [] });
});

test('changing the notification preference in the Details sheet persists it', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  setRouteParams({ id: 'c1' });
  await renderScreen(<ChatThreadScreen />);

  await pressHeaderDetails();
  await fireEvent.press(screen.getByText('Muted'));

  const row = getDb().executeSync(
    `SELECT notify_pref FROM conversation_participants WHERE conversation_id = 'c1' AND user_id = ?`, [ME],
  ).rows[0] as { notify_pref: string };
  expect(row.notify_pref).toBe('muted');
});

test('opening a thread drops the ChatBell unread cache for that conversation to zero', async () => {
  // src/chat/unread.ts is a module-level cache keyed by the id handed to
  // setChatCurrentUserId (the app layout does this from the session).
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  seedMessage('c1', 'user-bob', 'one', '2026-01-02T10:00:00Z');
  seedMessage('c1', 'user-bob', 'two', '2026-01-02T10:01:00Z');
  setChatCurrentUserId(ME);
  try {
    expect(chatUnreadCache.get()).toBe(2);
    setRouteParams({ id: 'c1' });
    await renderScreen(<ChatThreadScreen />);
    expect(chatUnreadCache.get()).toBe(0);
  } finally {
    setChatCurrentUserId(null);
  }
});
