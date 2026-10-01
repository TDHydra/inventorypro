// Render tests for the Activity Log screen (My Activity / Pending Sync).
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { stackScreenOptions } from '../../../test/mocks/expoRouter';
import LogsScreen from './index';

function seedLog(id: string, extra: Record<string, unknown> = {}) {
  seed('activity_log', {
    id, user_id: 'user-1', action: 'checkout_to_job', entity_type: 'item',
    created_at: new Date().toISOString(), ...extra,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the empty state with no activity', async () => {
  await renderScreen(<LogsScreen />);
  expect(screen.getByText('No activity yet')).toBeOnTheScreen();
  expect(screen.getByText('Actions you take will show up here.')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<LogsScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Activity Log', headerShown: true }),
  );
});

test('lists the signed-in user own activity with note and quantity', async () => {
  seedLog('l1', { note: 'Took tarps to site', quantity: 3, unit: 'ea', synced_at: '2026-01-01T00:00:00Z' });
  await renderScreen(<LogsScreen />);

  expect(screen.getByText('checkout to job')).toBeOnTheScreen();
  expect(screen.getByText('Took tarps to site')).toBeOnTheScreen();
  expect(screen.getByText('3 ea')).toBeOnTheScreen();
});

test("does not list another user's activity", async () => {
  seedLog('l1', { note: 'Mine', synced_at: '2026-01-01T00:00:00Z' });
  seedLog('l2', { user_id: 'someone-else', note: 'Theirs', synced_at: '2026-01-01T00:00:00Z' });
  await renderScreen(<LogsScreen />);

  expect(screen.getByText('Mine')).toBeOnTheScreen();
  expect(screen.queryByText('Theirs')).not.toBeOnTheScreen();
});

test('flags unsynced rows and the Pending Sync tab lists only those', async () => {
  seedLog('l1', { note: 'Already synced', synced_at: '2026-01-01T00:00:00Z' });
  seedLog('l2', { note: 'Not yet pushed' });
  await renderScreen(<LogsScreen />);
  expect(screen.getByText('Pending sync')).toBeOnTheScreen();

  await fireEvent.press(screen.getByText('Pending Sync'));
  expect(screen.getByText('Not yet pushed')).toBeOnTheScreen();
  expect(screen.queryByText('Already synced')).not.toBeOnTheScreen();
});

test('Pending Sync tab shows its own empty state and hides the filters', async () => {
  seedLog('l1', { synced_at: '2026-01-01T00:00:00Z' });
  await renderScreen(<LogsScreen />);
  expect(screen.getByPlaceholderText('Search note or name…')).toBeOnTheScreen();

  await fireEvent.press(screen.getByText('Pending Sync'));
  expect(screen.getByText('Nothing pending')).toBeOnTheScreen();
  expect(screen.getByText('Every local change has synced.')).toBeOnTheScreen();
  expect(screen.queryByPlaceholderText('Search note or name…')).not.toBeOnTheScreen();
});

test('the search box filters rows by note', async () => {
  seedLog('l1', { note: 'Tarps out', synced_at: '2026-01-01T00:00:00Z' });
  seedLog('l2', { note: 'Fans back', synced_at: '2026-01-01T00:00:00Z' });
  await renderScreen(<LogsScreen />);

  await fireEvent.changeText(screen.getByPlaceholderText('Search note or name…'), 'fans');
  expect(screen.getByText('Fans back')).toBeOnTheScreen();
  expect(screen.queryByText('Tarps out')).not.toBeOnTheScreen();
});
