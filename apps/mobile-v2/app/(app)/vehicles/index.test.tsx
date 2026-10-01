// Render tests for the Vehicles list screen.
// Reference example for the page-test harness — see test/renderScreen.tsx.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';
import VehiclesScreen from './index';

function seedVehicle(id: string, name: string, extra: Record<string, unknown> = {}) {
  seed('locations', {
    id, name, type: 'Vehicle', active: 1, updated_at: '2026-01-01T00:00:00Z', ...extra,
  });
}

beforeEach(async () => {
  // getVisibleUnits reads the whole locations table, so each test needs its own
  // slate rather than inheriting the previous test's vehicles.
  await initPageDb();
});

test('renders the empty state when there are no vehicles', async () => {
  await renderScreen(<VehiclesScreen />);
  expect(screen.getByText('No vehicles yet')).toBeOnTheScreen();
  // The segmented control is hidden until at least one vehicle exists.
  expect(screen.queryByText('All Vehicles')).not.toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<VehiclesScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Vehicles', headerShown: true }),
  );
});

test('lists seeded vehicles for an admin, with the manager caption', async () => {
  seedVehicle('v1', 'Box Truck');
  seedVehicle('v2', 'Service Van');
  await renderScreen(<VehiclesScreen />);

  expect(screen.getByText(/Box Truck/)).toBeOnTheScreen();
  expect(screen.getByText(/Service Van/)).toBeOnTheScreen();
  // full_admin is tier 4 → canSeeAllUnitsInManage → defaults to the All segment.
  expect(screen.getByText('Manager view — showing every vehicle.')).toBeOnTheScreen();
});

test('does not list lockers on the vehicles screen', async () => {
  seedVehicle('v1', 'Box Truck');
  seed('locations', {
    id: 'l1', name: 'Locker A', type: 'Locker', active: 1, updated_at: '2026-01-01T00:00:00Z',
  });
  await renderScreen(<VehiclesScreen />);

  expect(screen.getByText(/Box Truck/)).toBeOnTheScreen();
  expect(screen.queryByText(/Locker A/)).not.toBeOnTheScreen();
});

test('tapping a vehicle row navigates to its detail route', async () => {
  seedVehicle('v1', 'Box Truck');
  await renderScreen(<VehiclesScreen />);

  await fireEvent.press(screen.getByText(/Box Truck/));
  expect(navCalls).toContainEqual({
    method: 'push',
    args: [{ pathname: '/(app)/vehicles/[id]', params: { id: 'v1' } }],
  });
});

test('the Available segment shows its own empty state', async () => {
  seedVehicle('v1', 'Box Truck', { owner_user_id: 'someone-else' });
  await renderScreen(<VehiclesScreen />);

  await fireEvent.press(screen.getByText('Available'));
  // An owned vehicle whose owner has not opted in is not checkout-available.
  expect(screen.getByText('No vehicles available')).toBeOnTheScreen();
});
