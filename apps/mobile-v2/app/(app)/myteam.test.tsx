// Render tests for Manage My Team. No permission gate: crew membership, owned
// lockers and owned vehicles ARE the gate, so these tests drive it with data.
import { screen } from '@testing-library/react-native';
import { renderScreen } from '../../test/renderScreen';
import { seed, initPageDb } from '../../test/pageTestDb';
import { stackScreenOptions } from '../../test/mocks/expoRouter';
import MyTeamScreen from './myteam';

const TS = '2026-01-01T00:00:00Z';

function seedCrew(opts: { leadId: string; helperId?: string }) {
  seed('teams', { id: 't1', name: 'Mitigation', type: 'Crew', updated_at: TS });
  seed('subteams', { id: 'st1', team_id: 't1', name: 'Alpha Crew', active: 1, created_at: TS, updated_at: TS });
  seed('users', { id: opts.leadId, name: 'Lena Lead', role: 'mitigation_technician', pin_length_required: 4, created_at: TS, updated_at: TS });
  seed('team_members', { team_id: 't1', user_id: opts.leadId, joined_at: TS, updated_at: TS, subteam_id: 'st1', subteam_role: 'lead' });
  if (opts.helperId) {
    seed('users', { id: opts.helperId, name: 'Hank Helper', role: 'contents_crew', pin_length_required: 4, created_at: TS, updated_at: TS });
    seed('team_members', { team_id: 't1', user_id: opts.helperId, joined_at: TS, updated_at: TS, subteam_id: 'st1', subteam_role: 'helper' });
  }
}

beforeEach(async () => { await initPageDb(); });

test('renders the empty state when the user has no crew, locker or vehicle', async () => {
  await renderScreen(<MyTeamScreen />);
  expect(screen.getByText('Nothing to manage yet')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<MyTeamScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Manage My Team', headerShown: true }),
  );
});

test('renders nothing when signed out', async () => {
  await renderScreen(<MyTeamScreen />, { user: null });
  expect(screen.queryByText('Nothing to manage yet')).not.toBeOnTheScreen();
});

test('shows my crew with its lead and helper', async () => {
  seedCrew({ leadId: 'someone', helperId: 'user-1' });
  await renderScreen(<MyTeamScreen />);
  expect(screen.getByText('My Crew')).toBeOnTheScreen();
  expect(screen.getByText('Alpha Crew')).toBeOnTheScreen();
  expect(screen.getByText('Lena Lead')).toBeOnTheScreen();
  expect(screen.getByText('Hank Helper')).toBeOnTheScreen();
  expect(screen.queryByText('Nothing to manage yet')).not.toBeOnTheScreen();
});

test('only the crew lead gets the Edit link', async () => {
  seedCrew({ leadId: 'someone', helperId: 'user-1' });
  await renderScreen(<MyTeamScreen />);
  expect(screen.queryByText('Edit')).not.toBeOnTheScreen();
});

test('the crew lead sees Edit', async () => {
  seedCrew({ leadId: 'user-1', helperId: 'h2' });
  await renderScreen(<MyTeamScreen />);
  expect(screen.getByText('Edit')).toBeOnTheScreen();
});

test('a crew I am not in is not listed', async () => {
  seedCrew({ leadId: 'someone', helperId: 'other' });
  await renderScreen(<MyTeamScreen />);
  expect(screen.queryByText('Alpha Crew')).not.toBeOnTheScreen();
  expect(screen.getByText('Nothing to manage yet')).toBeOnTheScreen();
});

test('lists lockers I own, not other people\'s', async () => {
  seed('locations', { id: 'l1', name: 'My Locker A', type: 'Locker', active: 1, owner_user_id: 'user-1', updated_at: TS });
  seed('locations', { id: 'l2', name: 'Their Locker B', type: 'Locker', active: 1, owner_user_id: 'other', updated_at: TS });
  await renderScreen(<MyTeamScreen />);
  expect(screen.getByText('My Locker')).toBeOnTheScreen();
  expect(screen.getByText(/My Locker A/)).toBeOnTheScreen();
  expect(screen.getByText('Manage access')).toBeOnTheScreen();
  expect(screen.queryByText(/Their Locker B/)).not.toBeOnTheScreen();
});

test('lists vehicles I own', async () => {
  seed('locations', { id: 'v1', name: 'Box Truck', type: 'Vehicle', active: 1, owner_user_id: 'user-1', updated_at: TS });
  await renderScreen(<MyTeamScreen />);
  expect(screen.getByText('My Vehicle')).toBeOnTheScreen();
  expect(screen.getByText(/Box Truck/)).toBeOnTheScreen();
});
