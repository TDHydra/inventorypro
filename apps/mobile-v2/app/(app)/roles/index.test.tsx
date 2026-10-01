// Render tests for Roles & Permissions. Gating: manage_roles_permissions makes
// the screen editable; the tier guard (canActOnTarget) locks roles at/above the
// caller; delete_* grants are full_admin only.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { stackScreenOptions } from '../../../test/mocks/expoRouter';
import { ROLE_DISPLAY_NAMES } from '../../../src/constants/roles';
import RolesScreen from './index';

beforeEach(async () => { await initPageDb(); });

test('renders every role, highest tier first', async () => {
  await renderScreen(<RolesScreen />);
  for (const name of Object.values(ROLE_DISPLAY_NAMES)) {
    expect(screen.getByText(name)).toBeOnTheScreen();
  }
});

test('sets the header title and offers "Preview as…" to an admin', async () => {
  await renderScreen(<RolesScreen />);
  const opts = stackScreenOptions.find(o => o.title === 'Roles & Permissions');
  expect(opts).toBeDefined();
  expect(opts!.headerShown).toBe(true);
  expect(typeof opts!.headerRight).toBe('function');
});

test('a full admin is not shown the read-only banner', async () => {
  await renderScreen(<RolesScreen />);
  expect(screen.queryByText(/You can view roles but not change them/)).not.toBeOnTheScreen();
});

test('without manage_roles_permissions the screen is read-only and has no Preview as…', async () => {
  await renderScreen(<RolesScreen />, { role: 'hr_manager' });
  expect(screen.getByText(/You can view roles but not change them/)).toBeOnTheScreen();
  const opts = stackScreenOptions.find(o => o.title === 'Roles & Permissions');
  expect(opts!.headerRight).toBeUndefined();
  // the tier lock note only appears for people who COULD manage
  expect(screen.queryByText(/at or above your access level/)).not.toBeOnTheScreen();
});

test('full admin can act on every role, so no tier lock notes appear', async () => {
  await renderScreen(<RolesScreen />);
  expect(screen.queryByText(/at or above your access level/)).not.toBeOnTheScreen();
});

test('a tier-3 manager granted role management is locked out of roles above their tier', async () => {
  await renderScreen(<RolesScreen />, {
    role: 'office_manager', permissions: { manage_roles_permissions: true },
  });
  // full_admin + franchise_manager are tier 4 > tier 3.
  expect(screen.getAllByText(/at or above your access level/)).toHaveLength(2);
  expect(screen.queryByText(/You can view roles but not change them/)).not.toBeOnTheScreen();
});

test('expanding a role reveals its name-color picker and permission groups', async () => {
  await renderScreen(<RolesScreen />);
  expect(screen.queryByText('Name color')).not.toBeOnTheScreen();
  await fireEvent.press(screen.getByText('Construction Crew'));
  expect(screen.getByText('Name color')).toBeOnTheScreen();
  for (const group of ['Inventory', 'Jobs', 'Scheduling', 'Financial', 'Admin']) {
    expect(screen.getByText(group)).toBeOnTheScreen();
  }
});

test('only a full admin may grant delete permissions; a manager sees the reason', async () => {
  await renderScreen(<RolesScreen />, {
    role: 'office_manager', permissions: { manage_roles_permissions: true },
  });
  await fireEvent.press(screen.getByText('Construction Crew'));
  await fireEvent.press(screen.getByText('Inventory'));
  expect(screen.getByText('Delete catalog items')).toBeOnTheScreen();
  expect(screen.getAllByText('Only a full admin can grant this.').length).toBeGreaterThan(0);
});

test('a full admin editing a role sees no destructive-grant restriction', async () => {
  await renderScreen(<RolesScreen />);
  await fireEvent.press(screen.getByText('Construction Crew'));
  await fireEvent.press(screen.getByText('Inventory'));
  expect(screen.getByText('Delete catalog items')).toBeOnTheScreen();
  expect(screen.queryByText('Only a full admin can grant this.')).not.toBeOnTheScreen();
});

test('a stored role override is shown as "modified"', async () => {
  seed('role_settings', {
    role: 'construction_crew', min_pin_length: 6, updated_at: '2026-01-01T00:00:00Z',
    permission_overrides: JSON.stringify({ edit_inventory: true }),
  });
  await renderScreen(<RolesScreen />);
  await fireEvent.press(screen.getByText('Construction Crew'));
  await fireEvent.press(screen.getByText('Inventory'));
  expect(screen.getByText('modified')).toBeOnTheScreen();
});
