// Render tests for the Messages (chat list) screen.
// Unread state here comes from listConversations() (per-conversation COUNT
// against conversation_participants.last_read_at), NOT from src/chat/unread.ts —
// that module-level cache only drives the ChatBell badge in the app layout.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb, getDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';
import ChatListScreen from './index';

const TS = '2026-01-01T00:00:00Z';
const ME = 'user-1'; // the renderScreen default session user

function seedUser(id: string, name: string, role = 'construction_crew') {
  seed('users', {
    id, name, role, pin_length_required: 4, permission_overrides: '{}',
    active: 1, created_at: TS, updated_at: TS,
  });
}

function seedConversation(
  id: string,
  kind: 'dm' | 'group',
  members: string[],
  extra: Record<string, unknown> = {},
  memberExtra: Record<string, unknown> = {},
) {
  seed('conversations', { id, kind, created_by: ME, created_at: TS, updated_at: TS, ...extra });
  for (const uid of members) {
    seed('conversation_participants', {
      conversation_id: id, user_id: uid, notify_pref: 'all', added_at: TS, updated_at: TS,
      ...(uid === ME ? memberExtra : {}),
    });
  }
}

let msgSeq = 0;
function seedMessage(conversationId: string, senderId: string, body: string, at: string) {
  seed('messages', {
    id: `m-${++msgSeq}`, conversation_id: conversationId, sender_id: senderId, body,
    urgency: 'regular', created_at: at, updated_at: at,
  });
}

beforeEach(async () => {
  await initPageDb();
  seedUser(ME, 'Dev Tester', 'full_admin');
  seedUser('user-bob', 'Bob Builder');
  seedUser('user-cy', 'Cy Carpenter');
});

test('renders the empty state when there are no conversations', async () => {
  await renderScreen(<ChatListScreen />);
  expect(screen.getByText('No conversations')).toBeOnTheScreen();
  expect(screen.getByText('Tap + New to start a direct message or a group.')).toBeOnTheScreen();
});

test('sets the native header title to Messages', async () => {
  await renderScreen(<ChatListScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Messages', headerShown: true }),
  );
});

test('lists a DM under the peer name with its last message preview', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  seedMessage('c1', 'user-bob', 'Truck is loaded', '2026-01-02T10:00:00Z');
  await renderScreen(<ChatListScreen />);

  expect(screen.getByText('Bob Builder')).toBeOnTheScreen();
  expect(screen.getByText('Truck is loaded')).toBeOnTheScreen();
  expect(screen.queryByText('No conversations')).not.toBeOnTheScreen();
});

test('lists a group by its title and a message-less chat with a placeholder', async () => {
  seedConversation('g1', 'group', [ME, 'user-bob', 'user-cy'], { title: 'Crew Alpha' });
  await renderScreen(<ChatListScreen />);

  expect(screen.getByText('Crew Alpha')).toBeOnTheScreen();
  expect(screen.getByText('No messages yet')).toBeOnTheScreen();
});

test('shows an unread badge for messages newer than last_read_at, not for own or read ones', async () => {
  // c1: two unread from Bob. c2: Bob's message is older than my last_read_at.
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  seedMessage('c1', 'user-bob', 'one', '2026-01-02T10:00:00Z');
  seedMessage('c1', 'user-bob', 'two', '2026-01-02T10:01:00Z');
  seedMessage('c1', ME, 'my own reply', '2026-01-02T10:02:00Z');
  seedConversation('c2', 'dm', [ME, 'user-cy'], {}, { last_read_at: '2026-01-03T00:00:00Z' });
  seedMessage('c2', 'user-cy', 'already seen', '2026-01-02T09:00:00Z');
  await renderScreen(<ChatListScreen />);

  expect(screen.getByText('2')).toBeOnTheScreen();
  // Only c1 has a badge — c2 is fully read and own messages never count.
  expect(screen.queryByText('1')).not.toBeOnTheScreen();
  expect(screen.queryByText('3')).not.toBeOnTheScreen();
});

test('flags a muted conversation', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob'], {}, { notify_pref: 'muted' });
  await renderScreen(<ChatListScreen />);
  expect(screen.getByText('🔕')).toBeOnTheScreen();
});

test('does not list conversations the current user is not a participant of', async () => {
  seedConversation('c-other', 'dm', ['user-bob', 'user-cy']);
  seedMessage('c-other', 'user-bob', 'secret plans', '2026-01-02T10:00:00Z');
  await renderScreen(<ChatListScreen />);

  expect(screen.queryByText(/secret plans/)).not.toBeOnTheScreen();
  expect(screen.getByText('No conversations')).toBeOnTheScreen();
});

test('tapping a conversation navigates to its thread', async () => {
  seedConversation('c1', 'dm', [ME, 'user-bob']);
  seedMessage('c1', 'user-bob', 'hello', '2026-01-02T10:00:00Z');
  await renderScreen(<ChatListScreen />);

  await fireEvent.press(screen.getByText('Bob Builder'));
  expect(navCalls).toContainEqual({
    method: 'push',
    args: [{ pathname: '/(app)/chat/[id]', params: { id: 'c1' } }],
  });
});

test('the FAB opens the compose sheet, and picking one person creates a DM and opens it', async () => {
  await renderScreen(<ChatListScreen />);

  await fireEvent.press(screen.getByLabelText('New conversation'));
  expect(screen.getByText('Pick one person for a direct message, or several for a group.')).toBeOnTheScreen();

  // Can't start a chat until someone is picked.
  const start = screen.getByText('Start chat');
  await fireEvent.press(start);
  expect(navCalls.filter(c => c.method === 'push')).toHaveLength(0);

  await fireEvent(screen.getByPlaceholderText('Add people…'), 'focus');
  await fireEvent.press(screen.getByText('Bob Builder'));
  // The picked person becomes a removable chip.
  expect(screen.getByText('Bob Builder ✕')).toBeOnTheScreen();

  await fireEvent.press(screen.getByText('Start chat'));

  const convs = getDb().executeSync(`SELECT id, kind FROM conversations`).rows as Array<{ id: string; kind: string }>;
  expect(convs).toHaveLength(1);
  expect(convs[0].kind).toBe('dm');
  expect(navCalls).toContainEqual({
    method: 'push',
    args: [{ pathname: '/(app)/chat/[id]', params: { id: convs[0].id } }],
  });
});

test('picking two people switches to a group that needs a name', async () => {
  await renderScreen(<ChatListScreen />);
  await fireEvent.press(screen.getByLabelText('New conversation'));

  const picker = screen.getByPlaceholderText('Add people…');
  await fireEvent(picker, 'focus');
  await fireEvent.press(screen.getByText('Bob Builder'));
  await fireEvent(screen.getByPlaceholderText('Add people…'), 'focus');
  await fireEvent.press(screen.getByText('Cy Carpenter'));

  expect(screen.getByPlaceholderText('Group name')).toBeOnTheScreen();
  // Disabled until a group name is typed.
  await fireEvent.press(screen.getByText('Create group'));
  expect(navCalls.filter(c => c.method === 'push')).toHaveLength(0);

  await fireEvent.changeText(screen.getByPlaceholderText('Group name'), 'Roofers');
  await fireEvent.press(screen.getByText('Create group'));

  const convs = getDb().executeSync(`SELECT id, kind, title FROM conversations`).rows as Array<{ id: string; kind: string; title: string }>;
  expect(convs).toHaveLength(1);
  expect(convs[0]).toMatchObject({ kind: 'group', title: 'Roofers' });
  expect(navCalls.filter(c => c.method === 'push')).toHaveLength(1);
});
