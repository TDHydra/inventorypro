// Render tests for the Location detail route ([id] shape).
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { navCalls, setRouteParams, stackScreenOptions } from '../../../test/mocks/expoRouter';
import LocationDetailScreen from './[id]';

function seedLoc(id: string, name: string, extra: Record<string, unknown> = {}) {
  seed('locations', { id, name, active: 1, updated_at: '2026-01-01T00:00:00Z', ...extra });
}

beforeEach(async () => { await initPageDb(); });

test('renders the location it was routed to and sets the header title', async () => {
  seedLoc('l1', 'Main Warehouse');
  setRouteParams({ id: 'l1' });
  await renderScreen(<LocationDetailScreen />);

  expect(screen.getByText('Main Warehouse')).toBeOnTheScreen();
  expect(screen.getByText('Stock here')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Main Warehouse', headerShown: true }),
  );
});

test('shows the empty stock state', async () => {
  seedLoc('l1', 'Main Warehouse');
  setRouteParams({ id: 'l1' });
  await renderScreen(<LocationDetailScreen />);
  expect(screen.getByText('No count-based stock at this location.')).toBeOnTheScreen();
});

test('shows "Location not found." when the id does not resolve', async () => {
  setRouteParams({ id: 'does-not-exist' });
  await renderScreen(<LocationDetailScreen />);
  expect(screen.getByText('Location not found.')).toBeOnTheScreen();
});

test('shows the parent name for a sub-area', async () => {
  seedLoc('l1', 'Main Warehouse');
  seedLoc('l2', 'Cage', { parent_id: 'l1' });
  setRouteParams({ id: 'l2' });
  await renderScreen(<LocationDetailScreen />);
  expect(screen.getByText('Sub-area of')).toBeOnTheScreen();
  expect(screen.getByText('Main Warehouse')).toBeOnTheScreen();
});

test('lists sub-areas of a location and navigates into one', async () => {
  seedLoc('l1', 'Main Warehouse');
  seedLoc('l2', 'Cage', { parent_id: 'l1' });
  setRouteParams({ id: 'l1' });
  await renderScreen(<LocationDetailScreen />);

  expect(screen.getByText('Sub-areas')).toBeOnTheScreen();
  await fireEvent.press(screen.getByText(/Cage/));
  expect(navCalls.some(c => c.method === 'push' && JSON.stringify(c.args).includes('"id":"l2"'))).toBe(true);
});

test('shows Edit and Archive for a manager', async () => {
  seedLoc('l1', 'Main Warehouse');
  setRouteParams({ id: 'l1' });
  await renderScreen(<LocationDetailScreen />);
  expect(screen.getByText('Edit')).toBeOnTheScreen();
  expect(screen.getByText('Archive Location')).toBeOnTheScreen();
});

test('hides Edit and Archive without manage_locations', async () => {
  seedLoc('l1', 'Main Warehouse');
  setRouteParams({ id: 'l1' });
  await renderScreen(<LocationDetailScreen />, { permissions: { manage_locations: false } });
  expect(screen.getByText('Main Warehouse')).toBeOnTheScreen();
  expect(screen.queryByText('Edit')).not.toBeOnTheScreen();
  expect(screen.queryByText('Archive Location')).not.toBeOnTheScreen();
});

test('an archived location shows the banner and Restore instead of Archive', async () => {
  seedLoc('l1', 'Old Shed', { active: 0 });
  setRouteParams({ id: 'l1' });
  await renderScreen(<LocationDetailScreen />);
  expect(screen.getByText('Archived')).toBeOnTheScreen();
  expect(screen.getByText('Restore Location')).toBeOnTheScreen();
  expect(screen.queryByText('Archive Location')).not.toBeOnTheScreen();
});

test('shows the access-restricted gate without view_locations', async () => {
  seedLoc('l1', 'Main Warehouse');
  setRouteParams({ id: 'l1' });
  await renderScreen(<LocationDetailScreen />, { permissions: { view_locations: false } });
  expect(screen.getByText('Access restricted')).toBeOnTheScreen();
});
