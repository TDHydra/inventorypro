// Render tests for Users & Permissions. manage_users gates the whole screen; the
// edit sheet applies the role-hierarchy guard (canActOnTarget) to role, status
// and permission overrides.
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';
import UsersScreen from './index';

const TS = '2026-01-01T00:00:00Z';
function seedPerson(id: string, name: string, role: string, extra: Record<string, unknown> = {}) {
  seed('users', {
    id, name, role, pin_length_required: 4, active: 1, pin_set: 1,
    created_at: TS, updated_at: TS, ...extra,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the empty state when there are no users', async () => {
  await renderScreen(<UsersScreen />);
  expect(screen.getByText('No users found')).toBeOnTheScreen();
  expect(screen.getByText('+ New')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<UsersScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Users & Permissions', headerShown: true }),
  );
});

test('lists users with role names and tier badges', async () => {
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  seedPerson('u3', 'Olivia Office', 'office_manager');
  await renderScreen(<UsersScreen />);
  expect(screen.getByText('Ann Tech')).toBeOnTheScreen();
  expect(screen.getByText('Mitigation Technician')).toBeOnTheScreen();
  expect(screen.getByText('Olivia Office')).toBeOnTheScreen();
  expect(screen.getByText('Office Manager')).toBeOnTheScreen();
  expect(screen.getByText('T1')).toBeOnTheScreen();
  expect(screen.getByText('T3')).toBeOnTheScreen();
});

test('flags inactive, expired and PIN-less users', async () => {
  seedPerson('u2', 'Ann Tech', 'mitigation_technician', { active: 0 });
  seedPerson('u3', 'Tim Temp', 'temporary_employee', { expires_at: '2020-01-01T00:00:00Z' });
  seedPerson('u4', 'Newbie', 'contents_crew', { pin_set: 0 });
  await renderScreen(<UsersScreen />);
  expect(screen.getByText('Inactive')).toBeOnTheScreen();
  expect(screen.getByText('Expired')).toBeOnTheScreen();
  expect(screen.getByText('· PIN not set')).toBeOnTheScreen();
});

test('search filters the list by name', async () => {
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  seedPerson('u3', 'Bob Builder', 'construction_crew');
  await renderScreen(<UsersScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('Search users...'), 'bob');
  await waitFor(() => expect(screen.queryByText('Ann Tech')).not.toBeOnTheScreen());
  expect(screen.getByText('Bob Builder')).toBeOnTheScreen();
});

test('without manage_users the screen is replaced by a "Not authorized" gate', async () => {
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  await renderScreen(<UsersScreen />, { permissions: { manage_users: false } });
  expect(screen.getByText('Not authorized')).toBeOnTheScreen();
  expect(screen.queryByText('Ann Tech')).not.toBeOnTheScreen();
  expect(screen.queryByText('+ New')).not.toBeOnTheScreen();
});

test('a crew role is not authorized, and Go back navigates back', async () => {
  await renderScreen(<UsersScreen />, { role: 'construction_crew' });
  expect(screen.getByText('Not authorized')).toBeOnTheScreen();
  await fireEvent.press(screen.getByText('Go back'));
  expect(navCalls.some(c => c.method === 'back')).toBe(true);
});

test('an HR manager (tier 3, manage_users by default) can open the screen', async () => {
  await renderScreen(<UsersScreen />, { role: 'hr_manager' });
  expect(screen.queryByText('Not authorized')).not.toBeOnTheScreen();
  expect(screen.getByText('+ New')).toBeOnTheScreen();
});

test('+ New opens the create sheet with every role choice', async () => {
  await renderScreen(<UsersScreen />);
  await fireEvent.press(screen.getByText('+ New'));
  expect(screen.getByText('New User')).toBeOnTheScreen();
  expect(screen.getByText('Create User')).toBeOnTheScreen();
  expect(screen.getByText('Full Admin')).toBeOnTheScreen();
  expect(screen.getByText('Temporary Employee')).toBeOnTheScreen();
});

test('creating with a duplicate name warns before submitting', async () => {
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  await renderScreen(<UsersScreen />);
  await fireEvent.press(screen.getByText('+ New'));
  await fireEvent.changeText(screen.getByPlaceholderText('Full name'), 'ann tech');
  expect(screen.getByText(/already exists \(Mitigation Technician\)/)).toBeOnTheScreen();
});

test('tapping a user opens the edit sheet with account actions', async () => {
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  await renderScreen(<UsersScreen />);
  await fireEvent.press(screen.getByText('Ann Tech'));
  expect(screen.getByText('No Changes')).toBeOnTheScreen();
  expect(screen.getByText('Reset PIN')).toBeOnTheScreen();
  expect(screen.getByText('Deactivate')).toBeOnTheScreen();
  expect(screen.getByText('Permission Overrides')).toBeOnTheScreen();
  expect(screen.getByText('Matches Mitigation Technician default')).toBeOnTheScreen();
  expect(screen.queryByText(/at or above your access level/)).not.toBeOnTheScreen();
});

test('the edit sheet reports user-level overrides that differ from the role default', async () => {
  seedPerson('u2', 'Ann Tech', 'mitigation_technician', {
    permission_overrides: JSON.stringify({ manage_roles_permissions: true }),
  });
  await renderScreen(<UsersScreen />);
  await fireEvent.press(screen.getByText('Ann Tech'));
  expect(screen.getByText('1 override differ from Mitigation Technician default')).toBeOnTheScreen();
  expect(screen.getByText('changed · role default off')).toBeOnTheScreen();
});

test('hierarchy: a manager sees a lock note on a user at or above their tier', async () => {
  seedPerson('u2', 'Boss Admin', 'full_admin');
  await renderScreen(<UsersScreen />, { role: 'hr_manager' });
  await fireEvent.press(screen.getByText('Boss Admin'));
  expect(screen.getByText(/This user is at or above your access level/)).toBeOnTheScreen();
});

test('hierarchy: no lock note when acting on a lower-tier user', async () => {
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  await renderScreen(<UsersScreen />, { role: 'hr_manager' });
  await fireEvent.press(screen.getByText('Ann Tech'));
  expect(screen.queryByText(/at or above your access level/)).not.toBeOnTheScreen();
});

test('a temporary employee edit sheet offers expiry presets', async () => {
  seedPerson('u2', 'Tim Temp', 'temporary_employee');
  await renderScreen(<UsersScreen />);
  await fireEvent.press(screen.getByText('Tim Temp'));
  expect(screen.getByText('Access expires')).toBeOnTheScreen();
  expect(screen.getByText('+30 days')).toBeOnTheScreen();
});

test('the Personal Locker toggle needs manage_locations', async () => {
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  await renderScreen(<UsersScreen />, { permissions: { manage_locations: false } });
  await fireEvent.press(screen.getByText('Ann Tech'));
  expect(screen.queryByText('Personal Locker')).not.toBeOnTheScreen();
});

test('an admin with manage_locations sees the Personal Locker toggle', async () => {
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  await renderScreen(<UsersScreen />);
  await fireEvent.press(screen.getByText('Ann Tech'));
  expect(screen.getByText('Personal Locker')).toBeOnTheScreen();
});

test('long-press enters bulk select and shows the bulk action bar', async () => {
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  await renderScreen(<UsersScreen />);
  await fireEvent(screen.getByText('Ann Tech'), 'longPress');
  expect(screen.getByText('Change role')).toBeOnTheScreen();
  expect(screen.getByText('Add to team')).toBeOnTheScreen();
  expect(screen.getByText('Reactivate')).toBeOnTheScreen();
});

test('the message button starts a DM with another user, not with yourself', async () => {
  seedPerson('user-1', 'Dev Tester', 'full_admin');
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  await renderScreen(<UsersScreen />);
  expect(screen.queryByLabelText('Message Dev Tester')).not.toBeOnTheScreen();
  await fireEvent.press(screen.getByLabelText('Message Ann Tech'));
  expect(navCalls.some(c => c.method === 'push'
    && (c.args[0] as { pathname: string }).pathname === '/(app)/chat/[id]')).toBe(true);
});
