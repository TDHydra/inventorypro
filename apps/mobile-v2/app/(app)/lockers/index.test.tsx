// Render tests for the Lockers list screen (sibling of vehicles/index.test.tsx).
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';
import LockersScreen from './index';

function seedLocker(id: string, name: string, extra: Record<string, unknown> = {}) {
  seed('locations', {
    id, name, type: 'Locker', active: 1, updated_at: '2026-01-01T00:00:00Z', ...extra,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the empty state when there are no lockers', async () => {
  await renderScreen(<LockersScreen />);
  expect(screen.getByText('No lockers yet')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<LockersScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Lockers', headerShown: true }),
  );
});

test('lists seeded lockers for an admin, with the manager caption', async () => {
  seedLocker('k1', 'Locker A');
  seedLocker('k2', 'Locker B');
  await renderScreen(<LockersScreen />);

  expect(screen.getByText(/Locker A/)).toBeOnTheScreen();
  expect(screen.getByText(/Locker B/)).toBeOnTheScreen();
  expect(screen.getByText('Manager view — showing every locker.')).toBeOnTheScreen();
  expect(screen.queryByText('No lockers yet')).not.toBeOnTheScreen();
});

test('does not list vehicles or plain locations', async () => {
  seedLocker('k1', 'Locker A');
  seed('locations', { id: 'v1', name: 'Box Truck', type: 'Vehicle', active: 1, updated_at: '2026-01-01T00:00:00Z' });
  seed('locations', { id: 'l1', name: 'Warehouse', active: 1, updated_at: '2026-01-01T00:00:00Z' });
  await renderScreen(<LockersScreen />);

  expect(screen.getByText(/Locker A/)).toBeOnTheScreen();
  expect(screen.queryByText(/Box Truck/)).not.toBeOnTheScreen();
  expect(screen.queryByText(/Warehouse/)).not.toBeOnTheScreen();
});

test('shows "No owner" for an unowned locker', async () => {
  seedLocker('k1', 'Locker A');
  await renderScreen(<LockersScreen />);
  expect(screen.getByText('No owner')).toBeOnTheScreen();
});

test('shows the empty state when signed out', async () => {
  seedLocker('k1', 'Locker A');
  await renderScreen(<LockersScreen />, { user: null });
  expect(screen.getByText('No lockers yet')).toBeOnTheScreen();
});

test('tapping a locker row navigates to its detail route', async () => {
  seedLocker('k1', 'Locker A');
  await renderScreen(<LockersScreen />);

  await fireEvent.press(screen.getByText(/Locker A/));
  expect(navCalls).toContainEqual({
    method: 'push',
    args: [{ pathname: '/(app)/lockers/[id]', params: { id: 'k1' } }],
  });
});
