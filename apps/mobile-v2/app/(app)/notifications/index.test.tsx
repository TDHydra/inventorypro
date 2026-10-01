// Render tests for the Notifications inbox.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb, getDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';
import NotificationsScreen from './index';

const TS = '2026-01-01T00:00:00Z';
function seedNote(id: string, title: string, extra: Record<string, unknown> = {}) {
  seed('notifications', {
    id, user_id: 'user-1', type: 'broadcast', title, body: `${title} body`,
    created_at: TS, updated_at: TS, ...extra,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the empty state when the inbox is empty', async () => {
  await renderScreen(<NotificationsScreen />);
  expect(screen.getByText('No notifications')).toBeOnTheScreen();
  expect(screen.queryByText('Mark all read')).not.toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<NotificationsScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Notifications', headerShown: true }),
  );
});

test('lists notifications with an unread count and mark-all action', async () => {
  seedNote('n1', 'Truck restocked');
  seedNote('n2', 'Old news', { read_at: TS });
  await renderScreen(<NotificationsScreen />);
  expect(screen.getByText('Truck restocked')).toBeOnTheScreen();
  expect(screen.getByText('Old news')).toBeOnTheScreen();
  expect(screen.getByText('1 unread')).toBeOnTheScreen();
  expect(screen.getByText('Mark all read')).toBeOnTheScreen();
});

test('Mark all read marks every notification read and hides the bar', async () => {
  seedNote('n1', 'First');
  seedNote('n2', 'Second');
  await renderScreen(<NotificationsScreen />);
  await fireEvent.press(screen.getByText('Mark all read'));
  const rows = getDb().executeSync('SELECT read_at FROM notifications').rows as { read_at: string | null }[];
  expect(rows.every(r => r.read_at != null)).toBe(true);
  expect(screen.queryByText('Mark all read')).not.toBeOnTheScreen();
});

test('tapping an inventory notification marks it read and deep-links to the item', async () => {
  seedNote('n1', 'Low stock: Gloves', {
    type: 'low_stock', data: JSON.stringify({ screen: 'inventory', id: 'item-9' }),
  });
  await renderScreen(<NotificationsScreen />);
  await fireEvent.press(screen.getByText('Low stock: Gloves'));
  expect(navCalls).toContainEqual({
    method: 'push',
    args: [{ pathname: '/(app)/inventory/[id]', params: { id: 'item-9' } }],
  });
  const row = getDb().executeSync('SELECT read_at FROM notifications WHERE id = ?', ['n1']).rows[0] as { read_at: string | null };
  expect(row.read_at).not.toBeNull();
});

test('a broadcast notification stays on the inbox when tapped', async () => {
  seedNote('n1', 'Team meeting', { data: JSON.stringify({ screen: 'notifications' }) });
  await renderScreen(<NotificationsScreen />);
  await fireEvent.press(screen.getByText('Team meeting'));
  expect(navCalls.filter(c => c.method === 'push')).toHaveLength(0);
});

test('open approval requests show Approve/Reject; decided ones do not', async () => {
  seed('approval_requests', {
    id: 'a1', requester_id: 'u2', kind: 'manual', title: 'Buy ladder', status: 'open',
    created_at: TS, updated_at: TS,
  });
  seed('approval_requests', {
    id: 'a2', requester_id: 'u2', kind: 'manual', title: 'Old ask', status: 'approved',
    created_at: TS, updated_at: TS,
  });
  seedNote('n1', 'Approval: ladder', { type: 'approval_request', data: JSON.stringify({ id: 'a1' }) });
  await renderScreen(<NotificationsScreen />);
  expect(screen.getByText('Approve')).toBeOnTheScreen();
  expect(screen.getByText('Reject')).toBeOnTheScreen();
});

test('an approval notification whose request is already decided has no actions', async () => {
  seed('approval_requests', {
    id: 'a2', requester_id: 'u2', kind: 'manual', title: 'Old ask', status: 'approved',
    created_at: TS, updated_at: TS,
  });
  seedNote('n1', 'Approval: old', { type: 'approval_request', data: JSON.stringify({ id: 'a2' }) });
  await renderScreen(<NotificationsScreen />);
  expect(screen.getByText('Approval: old')).toBeOnTheScreen();
  expect(screen.queryByText('Approve')).not.toBeOnTheScreen();
});
