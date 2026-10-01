// Render tests for the Access screen (unit_access grants across lockers).
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { stackScreenOptions } from '../../../test/mocks/expoRouter';
import AccessScreen from './index';

const TS = '2026-01-01T00:00:00Z';

function seedLocker(id: string, name: string, extra: Record<string, unknown> = {}) {
  seed('locations', { id, name, type: 'Locker', active: 1, updated_at: TS, ...extra });
}
function seedUser(id: string, name: string) {
  seed('users', {
    id, name, role: 'tech', pin_length_required: 4, active: 1, created_at: TS, updated_at: TS,
  });
}
function seedGrant(locationId: string, userId: string) {
  seed('unit_access', {
    location_id: locationId, user_id: userId, can_view: 1, created_at: TS, updated_at: TS,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the empty state when there are no grants', async () => {
  await renderScreen(<AccessScreen />);
  expect(screen.getByText('No access grants')).toBeOnTheScreen();
  expect(screen.getByText('+ Grant')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<AccessScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Access', headerShown: true }),
  );
});

test('lists seeded grants with locker and person names', async () => {
  seedLocker('k1', 'Locker A');
  seedUser('u2', 'Gary Grantee');
  seedGrant('k1', 'u2');
  await renderScreen(<AccessScreen />);

  expect(screen.getByText('🔒 Locker A')).toBeOnTheScreen();
  expect(screen.getByText('Gary Grantee')).toBeOnTheScreen();
  expect(screen.getByText('Revoke')).toBeOnTheScreen();
  expect(screen.queryByText('No access grants')).not.toBeOnTheScreen();
});

test('does not list grants on vehicles (lockers only)', async () => {
  seedLocker('k1', 'Locker A');
  seed('locations', { id: 'v1', name: 'Box Truck', type: 'Vehicle', active: 1, updated_at: TS });
  seedUser('u2', 'Gary Grantee');
  seedGrant('k1', 'u2');
  seedGrant('v1', 'u2');
  await renderScreen(<AccessScreen />);

  expect(screen.getByText('🔒 Locker A')).toBeOnTheScreen();
  expect(screen.queryByText(/Box Truck/)).not.toBeOnTheScreen();
});

test('the filter narrows grants by locker name', async () => {
  seedLocker('k1', 'Locker A');
  seedLocker('k2', 'Locker B');
  seedUser('u2', 'Gary Grantee');
  seedGrant('k1', 'u2');
  seedGrant('k2', 'u2');
  await renderScreen(<AccessScreen />);

  await fireEvent.changeText(screen.getByPlaceholderText('Filter by locker or user…'), 'Locker B');
  expect(screen.getByText('🔒 Locker B')).toBeOnTheScreen();
  expect(screen.queryByText('🔒 Locker A')).not.toBeOnTheScreen();
});

test('shows the Defaults button for a system_settings holder', async () => {
  await renderScreen(<AccessScreen />);
  expect(screen.getByText('Defaults')).toBeOnTheScreen();
});

test('hides the Defaults button without system_settings', async () => {
  // full_admin has a permission floor on system_settings that overrides cannot
  // remove, so use a lower role granted manage_locations at the user level.
  await renderScreen(<AccessScreen />, {
    role: 'hr_manager', permissions: { manage_locations: true },
  });
  expect(screen.queryByText('Defaults')).not.toBeOnTheScreen();
  expect(screen.getByText('+ Grant')).toBeOnTheScreen();
});

test('shows the access-restricted gate without manage_locations', async () => {
  await renderScreen(<AccessScreen />, { permissions: { manage_locations: false } });
  expect(screen.getByText('Access restricted')).toBeOnTheScreen();
  expect(screen.queryByText('+ Grant')).not.toBeOnTheScreen();
});

test('+ Grant opens the grant sheet', async () => {
  await renderScreen(<AccessScreen />);
  await fireEvent.press(screen.getByText('+ Grant'));
  expect(screen.getByText('Grant Locker Access')).toBeOnTheScreen();
});
