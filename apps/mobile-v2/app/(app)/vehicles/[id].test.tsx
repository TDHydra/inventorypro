// Render tests for the Vehicle detail route (thin wrapper around VehiclePanel).
import { screen } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { setRouteParams, stackScreenOptions } from '../../../test/mocks/expoRouter';
import VehicleDetailScreen from './[id]';

function seedVehicle(id: string, name: string, extra: Record<string, unknown> = {}) {
  seed('locations', {
    id, name, type: 'Vehicle', active: 1, updated_at: '2026-01-01T00:00:00Z', ...extra,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the vehicle it was routed to', async () => {
  seedVehicle('v1', 'Box Truck');
  setRouteParams({ id: 'v1' });
  await renderScreen(<VehicleDetailScreen />);
  expect(screen.getByText(/Box Truck/)).toBeOnTheScreen();
});

test('uses the vehicle name as the header title', async () => {
  seedVehicle('v1', 'Box Truck');
  setRouteParams({ id: 'v1' });
  await renderScreen(<VehicleDetailScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Box Truck', headerShown: true }),
  );
});

test('shows the State, Checkout and Contents sections', async () => {
  seedVehicle('v1', 'Box Truck');
  setRouteParams({ id: 'v1' });
  await renderScreen(<VehicleDetailScreen />);
  expect(screen.getByText('State')).toBeOnTheScreen();
  expect(screen.getByText('Checkout')).toBeOnTheScreen();
  expect(screen.getByText('Contents')).toBeOnTheScreen();
  expect(screen.getByText('Not checked out.')).toBeOnTheScreen();
});

test('shows "Vehicle not found." and the fallback title when the id does not resolve', async () => {
  setRouteParams({ id: 'does-not-exist' });
  await renderScreen(<VehicleDetailScreen />);
  expect(screen.getByText('Vehicle not found.')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Vehicle' }));
});
