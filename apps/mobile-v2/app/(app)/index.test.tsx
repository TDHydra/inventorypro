// Render tests for the dashboard hub (signed in): greeting, role-keyed
// dashboard preset, the tile grid, and permission-gated admin tiles.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen, makeUser } from '../../test/renderScreen';
import { initPageDb } from '../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../test/mocks/expoRouter';
import Hub from './index';

beforeEach(async () => { await initPageDb(); });

test('renders the greeting, name and role for the signed-in admin', async () => {
  await renderScreen(<Hub />);
  expect(screen.getByText('Welcome back,')).toBeOnTheScreen();
  expect(screen.getByText('Dev Tester')).toBeOnTheScreen();
  expect(screen.getByText('Full Admin')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<Hub />);
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'InventoryPro' }));
});

test('renders nothing when signed out', async () => {
  await renderScreen(<Hub />, { user: null });
  expect(screen.queryByText('Welcome back,')).not.toBeOnTheScreen();
  expect(screen.queryByText('Inventory')).not.toBeOnTheScreen();
});

test('shows the admin preset stat tiles, and not crew-only ones', async () => {
  await renderScreen(<Hub />);
  expect(screen.getByText('Scheduled Today')).toBeOnTheScreen();
  expect(screen.getByText('Low Stock')).toBeOnTheScreen();
  expect(screen.queryByText('My Checkouts')).not.toBeOnTheScreen();
});

test('a field-crew role gets the crew preset stat tiles instead', async () => {
  await renderScreen(<Hub />, { user: makeUser({ role: 'construction_crew' }) });
  expect(screen.getByText('My Checkouts')).toBeOnTheScreen();
  expect(screen.queryByText('Scheduled Today')).not.toBeOnTheScreen();
});

test('renders the universal navigation tiles', async () => {
  await renderScreen(<Hub />);
  for (const label of ['Scan', 'Check Out / In', 'Inventory', 'Locations', 'Equipment', 'Jobs', 'Vehicles', 'Lockers']) {
    expect(screen.getByText(label)).toBeOnTheScreen();
  }
});

test('admin-only tiles show for a full admin', async () => {
  await renderScreen(<Hub />);
  expect(screen.getByText('Users')).toBeOnTheScreen();
  expect(screen.getByText('Roles')).toBeOnTheScreen();
  expect(screen.getByText('Access')).toBeOnTheScreen();
  expect(screen.getByText('Approvals')).toBeOnTheScreen();
});

test('admin tiles are hidden when their permissions are revoked', async () => {
  await renderScreen(<Hub />, {
    permissions: { manage_users: false, manage_roles_permissions: false, manage_locations: false, manage_teams: false },
  });
  expect(screen.queryByText('Users')).not.toBeOnTheScreen();
  expect(screen.queryByText('Access')).not.toBeOnTheScreen();
  expect(screen.queryByText('Approvals')).not.toBeOnTheScreen();
  // ungated tiles stay
  expect(screen.getByText('Inventory')).toBeOnTheScreen();
});

test('full_admin keeps the Roles tile even if the override is revoked (FULL_ADMIN_FLOOR)', async () => {
  await renderScreen(<Hub />, { permissions: { manage_roles_permissions: false } });
  expect(screen.getByText('Roles')).toBeOnTheScreen();
});

test('tapping a tile pushes its route', async () => {
  await renderScreen(<Hub />);
  await fireEvent.press(screen.getByText('Inventory'));
  expect(navCalls).toContainEqual({ method: 'push', args: ['/(app)/inventory'] });
});

test('the settings link pushes the settings route', async () => {
  await renderScreen(<Hub />);
  await fireEvent.press(screen.getByText('Settings & sync status →'));
  expect(navCalls).toContainEqual({ method: 'push', args: ['/(app)/settings'] });
});
