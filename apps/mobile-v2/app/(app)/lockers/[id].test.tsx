// Render tests for the Locker detail route (thin wrapper around LockerPanel).
import { screen } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { setRouteParams, stackScreenOptions } from '../../../test/mocks/expoRouter';
import LockerDetailScreen from './[id]';

function seedLocker(id: string, name: string, extra: Record<string, unknown> = {}) {
  seed('locations', {
    id, name, type: 'Locker', active: 1, updated_at: '2026-01-01T00:00:00Z', ...extra,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the locker it was routed to', async () => {
  seedLocker('k1', 'Locker A');
  setRouteParams({ id: 'k1' });
  await renderScreen(<LockerDetailScreen />);
  expect(screen.getByText('Locker A')).toBeOnTheScreen();
  expect(screen.getByText('Owner')).toBeOnTheScreen();
});

test('uses the locker name as the header title', async () => {
  seedLocker('k1', 'Locker A');
  setRouteParams({ id: 'k1' });
  await renderScreen(<LockerDetailScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Locker A', headerShown: true }),
  );
});

test('shows "No owner" for an unowned locker', async () => {
  seedLocker('k1', 'Locker A');
  setRouteParams({ id: 'k1' });
  await renderScreen(<LockerDetailScreen />);
  expect(screen.getByText('No owner')).toBeOnTheScreen();
});

test('shows the owner name when the locker is owned', async () => {
  seed('users', {
    id: 'u9', name: 'Olivia Owner', role: 'tech', pin_length_required: 4, active: 1,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  });
  seedLocker('k1', 'Locker A', { owner_user_id: 'u9' });
  setRouteParams({ id: 'k1' });
  await renderScreen(<LockerDetailScreen />);
  expect(screen.getByText('Olivia Owner')).toBeOnTheScreen();
});

test('shows "Locker not found" and the fallback title when the id does not resolve', async () => {
  setRouteParams({ id: 'does-not-exist' });
  await renderScreen(<LockerDetailScreen />);
  expect(screen.getByText('Locker not found')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Locker' }));
});
