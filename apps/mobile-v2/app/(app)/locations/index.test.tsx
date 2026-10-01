// Render tests for the Locations browser (tree of places; units excluded).
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';
import LocationsScreen from './index';

function seedLoc(id: string, name: string, extra: Record<string, unknown> = {}) {
  seed('locations', { id, name, active: 1, updated_at: '2026-01-01T00:00:00Z', ...extra });
}

beforeEach(async () => { await initPageDb(); });

test('renders the empty state with the add hint for a manager', async () => {
  await renderScreen(<LocationsScreen />);
  expect(screen.getByText(/No locations yet\./)).toBeOnTheScreen();
  expect(screen.getByText(/Tap "\+ New"/)).toBeOnTheScreen();
  expect(screen.getByText('0 locations')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<LocationsScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Locations', headerShown: true }),
  );
});

test('lists seeded top-level locations with sub-area counts', async () => {
  seedLoc('l1', 'Main Warehouse');
  seedLoc('l2', 'Shop');
  seedLoc('l3', 'Cage', { parent_id: 'l1' });
  await renderScreen(<LocationsScreen />);

  expect(screen.getByText('Main Warehouse')).toBeOnTheScreen();
  expect(screen.getByText('Shop')).toBeOnTheScreen();
  expect(screen.getByText('1 sub-area')).toBeOnTheScreen();
  expect(screen.getByText('2 locations')).toBeOnTheScreen();
  // The child is collapsed until its parent is expanded.
  expect(screen.queryByText('Cage')).not.toBeOnTheScreen();
});

test('expanding a node reveals its sub-areas and the add-sub-area affordance', async () => {
  seedLoc('l1', 'Main Warehouse');
  seedLoc('l3', 'Cage', { parent_id: 'l1' });
  await renderScreen(<LocationsScreen />);

  await fireEvent.press(screen.getByText('▸'));
  expect(screen.getByText('Cage')).toBeOnTheScreen();
  expect(screen.getByText('+ Add sub-area')).toBeOnTheScreen();
});

test('does not list vehicles or lockers (they are units, not places)', async () => {
  seedLoc('l1', 'Main Warehouse');
  seedLoc('v1', 'Box Truck', { type: 'Vehicle' });
  seedLoc('k1', 'Locker A', { type: 'Locker' });
  await renderScreen(<LocationsScreen />);

  expect(screen.getByText('Main Warehouse')).toBeOnTheScreen();
  expect(screen.queryByText('Box Truck')).not.toBeOnTheScreen();
  expect(screen.queryByText('Locker A')).not.toBeOnTheScreen();
});

test('hides the + New button without manage_locations', async () => {
  seedLoc('l1', 'Main Warehouse');
  await renderScreen(<LocationsScreen />, { permissions: { manage_locations: false } });
  expect(screen.getByText('Main Warehouse')).toBeOnTheScreen();
  expect(screen.queryByText('+ New')).not.toBeOnTheScreen();
});

test('shows the access-restricted gate without view_locations', async () => {
  seedLoc('l1', 'Main Warehouse');
  await renderScreen(<LocationsScreen />, { permissions: { view_locations: false } });
  expect(screen.getByText('Access restricted')).toBeOnTheScreen();
  expect(screen.queryByText('Main Warehouse')).not.toBeOnTheScreen();
});

test('tapping a location navigates to its detail route', async () => {
  seedLoc('l1', 'Main Warehouse');
  await renderScreen(<LocationsScreen />);

  await fireEvent.press(screen.getByText('Main Warehouse'));
  expect(navCalls).toContainEqual({
    method: 'push',
    args: [{ pathname: '/(app)/locations/[id]', params: { id: 'l1' } }],
  });
});

test('+ New opens the create sheet', async () => {
  await renderScreen(<LocationsScreen />);
  await fireEvent.press(screen.getByText('+ New'));
  expect(screen.getByText('New location')).toBeOnTheScreen();
  expect(screen.getByPlaceholderText('Location name *')).toBeOnTheScreen();
});
