// Render tests for the Team detail route. Gating is the point here: org
// authority (tier >= 3) and team managers get roster controls, a team manager
// without org authority gets a restricted view, plain members are read-only and
// outsiders are turned away. view_teams gates the whole screen.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { setRouteParams, stackScreenOptions, navCalls } from '../../../test/mocks/expoRouter';
import TeamDetailScreen from './[id]';

const TS = '2026-01-01T00:00:00Z';

function seedTeam() {
  seed('teams', { id: 't1', name: 'Mitigation Crew', type: 'Crew', updated_at: TS });
}
function seedPerson(id: string, name: string, role: string) {
  seed('users', { id, name, role, pin_length_required: 4, created_at: TS, updated_at: TS });
}
function seedMember(user_id: string, is_manager = 0) {
  seed('team_members', { team_id: 't1', user_id, joined_at: TS, updated_at: TS, is_manager });
}

beforeEach(async () => {
  await initPageDb();
  setRouteParams({ id: 't1' });
});

test('shows "Team not found" when the id does not resolve', async () => {
  setRouteParams({ id: 'nope' });
  await renderScreen(<TeamDetailScreen />);
  expect(screen.getByText('Team not found.')).toBeOnTheScreen();
});

test('an admin sees the team, its roster and the empty crews state', async () => {
  seedTeam();
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  seedMember('u2');
  await renderScreen(<TeamDetailScreen />);
  expect(screen.getByText('Mitigation Crew')).toBeOnTheScreen();
  expect(screen.getByText('Members (1)')).toBeOnTheScreen();
  expect(screen.getByText('Ann Tech')).toBeOnTheScreen();
  expect(screen.getByText('Mitigation Technician')).toBeOnTheScreen();
  expect(screen.getByText('Crews (0)')).toBeOnTheScreen();
});

test('uses the team name as the native header title', async () => {
  seedTeam();
  await renderScreen(<TeamDetailScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Mitigation Crew', headerShown: true }),
  );
});

test('an admin with an empty roster is invited to add members', async () => {
  seedTeam();
  await renderScreen(<TeamDetailScreen />);
  expect(screen.getByText(/No members yet/)).toBeOnTheScreen();
  expect(screen.getByText('Edit Team')).toBeOnTheScreen();
});

test('an admin gets Make manager / Perms / Remove controls for each member', async () => {
  seedTeam();
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  seedMember('u2');
  await renderScreen(<TeamDetailScreen />);
  expect(screen.getByText('Make manager')).toBeOnTheScreen();
  expect(screen.getByText('Perms')).toBeOnTheScreen();
  expect(screen.getByText('Remove')).toBeOnTheScreen();
  expect(screen.getAllByText('+ Add')).toHaveLength(2); // members + crews
});

test('a promoted member shows the manager chip in the header card', async () => {
  seedTeam();
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  seedMember('u2', 1);
  await renderScreen(<TeamDetailScreen />);
  expect(screen.getByText('Manager')).toBeOnTheScreen();
  expect(screen.getByText('★ Manager')).toBeOnTheScreen();
});

test('a plain team member sees the roster read-only', async () => {
  seedTeam();
  seedPerson('user-1', 'Dev Tester', 'construction_crew');
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  seedMember('user-1');
  seedMember('u2', 1);
  await renderScreen(<TeamDetailScreen />, { role: 'construction_crew' });
  expect(screen.getAllByText('Ann Tech').length).toBeGreaterThan(0); // roster row + manager chip
  expect(screen.queryByText('Edit Team')).not.toBeOnTheScreen();
  expect(screen.queryByText('+ Add')).not.toBeOnTheScreen();
  expect(screen.queryByText('Remove')).not.toBeOnTheScreen();
  expect(screen.queryByText('Make manager')).not.toBeOnTheScreen();
  expect(screen.getAllByText('Manager')).toHaveLength(2); // header label + read-only row badge
});

test('a non-member without org authority is turned away', async () => {
  seedTeam();
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  seedMember('u2');
  await renderScreen(<TeamDetailScreen />, { role: 'construction_crew' });
  expect(screen.getByText("You're not a member of this team")).toBeOnTheScreen();
  expect(screen.queryByText('Ann Tech')).not.toBeOnTheScreen();
});

test('a team manager without org authority sees the restricted-manager note', async () => {
  seedTeam();
  seedPerson('user-1', 'Dev Tester', 'head_of_contents');
  seedMember('user-1', 1);
  await renderScreen(<TeamDetailScreen />, { role: 'head_of_contents' });
  expect(screen.getByText(/Only an organization admin can appoint managers/)).toBeOnTheScreen();
  expect(screen.getByText('Edit Team')).toBeOnTheScreen();
});

test('an org-authority user is not shown the restricted-manager note', async () => {
  seedTeam();
  seedPerson('user-1', 'Dev Tester', 'hr_manager');
  seedMember('user-1', 1);
  await renderScreen(<TeamDetailScreen />, { role: 'hr_manager' });
  expect(screen.queryByText(/Only an organization admin can appoint managers/)).not.toBeOnTheScreen();
});

test('members at or above the caller tier are lock-noted', async () => {
  seedTeam();
  seedPerson('user-1', 'Dev Tester', 'office_manager');
  seedPerson('u2', 'Boss Admin', 'full_admin');
  seedMember('user-1');
  seedMember('u2');
  await renderScreen(<TeamDetailScreen />, { role: 'office_manager' });
  expect(screen.getByText(/At or above your access level/)).toBeOnTheScreen();
});

test('revoking view_teams shows the permission gate instead of the team', async () => {
  seedTeam();
  await renderScreen(<TeamDetailScreen />, { permissions: { view_teams: false } });
  expect(screen.getByText('Access restricted')).toBeOnTheScreen();
  expect(screen.queryByText('Mitigation Crew')).not.toBeOnTheScreen();
});

test('the message button starts a DM and pushes the chat route', async () => {
  seedTeam();
  seedPerson('user-1', 'Dev Tester', 'full_admin');
  seedPerson('u2', 'Ann Tech', 'mitigation_technician');
  seedMember('u2');
  await renderScreen(<TeamDetailScreen />);
  await fireEvent.press(screen.getByLabelText('Message Ann Tech'));
  expect(navCalls.some(c => c.method === 'push'
    && (c.args[0] as { pathname: string }).pathname === '/(app)/chat/[id]')).toBe(true);
});
