// Render tests for the Teams list screen. Gating: view_teams gates the whole
// screen, manage_teams gates "+ New", and org authority (tier >= 3) decides
// whether the screen shows the My Teams / All Teams split.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';
import TeamsScreen from './index';

const TS = '2026-01-01T00:00:00Z';
function seedTeam(id: string, name: string, type = 'Crew') {
  seed('teams', { id, name, type, updated_at: TS });
}
function seedMember(team_id: string, user_id: string, is_manager = 0) {
  seed('team_members', { team_id, user_id, joined_at: TS, updated_at: TS, is_manager });
}

beforeEach(async () => { await initPageDb(); });

test('admin with no teams sees both empty sections and the create hint', async () => {
  await renderScreen(<TeamsScreen />);
  expect(screen.getByText('My Teams')).toBeOnTheScreen();
  expect(screen.getByText("You're not on a team yet.")).toBeOnTheScreen();
  expect(screen.getByText('All Teams')).toBeOnTheScreen();
  expect(screen.getByText(/No teams set up yet/)).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<TeamsScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Teams', headerShown: true }),
  );
});

test('admin sees every team under All Teams, and the manager badge under My Teams', async () => {
  seedTeam('t1', 'Mitigation Crew');
  seedTeam('t2', 'Contents Crew');
  seedMember('t1', 'user-1', 1);
  await renderScreen(<TeamsScreen />);
  expect(screen.getAllByText('Mitigation Crew')).toHaveLength(2); // My Teams + All Teams
  expect(screen.getAllByText('Contents Crew')).toHaveLength(1);
  expect(screen.getByText('Manager')).toBeOnTheScreen();
  expect(screen.getByText('2 teams')).toBeOnTheScreen();
});

test('tapping a team pushes its detail route', async () => {
  seedTeam('t1', 'Contents Crew');
  await renderScreen(<TeamsScreen />);
  await fireEvent.press(screen.getByText('Contents Crew'));
  expect(navCalls).toContainEqual({
    method: 'push',
    args: [{ pathname: '/(app)/teams/[id]', params: { id: 't1' } }],
  });
});

test('an admin can open the create-team sheet', async () => {
  await renderScreen(<TeamsScreen />);
  await fireEvent.press(screen.getByText('+ New'));
  expect(screen.getByText('New Team')).toBeOnTheScreen();
  expect(screen.getByText('Create Team')).toBeOnTheScreen();
});

test('without manage_teams there is no "+ New" button', async () => {
  await renderScreen(<TeamsScreen />, { permissions: { manage_teams: false } });
  expect(screen.queryByText('+ New')).not.toBeOnTheScreen();
});

test('a crew member only sees teams they belong to (no org split)', async () => {
  seedTeam('t1', 'Mine');
  seedTeam('t2', 'Theirs');
  seedMember('t1', 'user-1');
  await renderScreen(<TeamsScreen />, { role: 'construction_crew' });
  expect(screen.getByText('Mine')).toBeOnTheScreen();
  expect(screen.queryByText('Theirs')).not.toBeOnTheScreen();
  expect(screen.queryByText('All Teams')).not.toBeOnTheScreen();
  expect(screen.queryByText('+ New')).not.toBeOnTheScreen();
});

test('a crew member on no team gets the empty state', async () => {
  seedTeam('t2', 'Theirs');
  await renderScreen(<TeamsScreen />, { role: 'construction_crew' });
  expect(screen.getByText("You're not on a team yet")).toBeOnTheScreen();
  expect(screen.queryByText('Theirs')).not.toBeOnTheScreen();
});

test('revoking view_teams replaces the screen with a permission gate', async () => {
  seedTeam('t1', 'Contents Crew');
  await renderScreen(<TeamsScreen />, { permissions: { view_teams: false } });
  expect(screen.getByText('Access restricted')).toBeOnTheScreen();
  expect(screen.queryByText('Contents Crew')).not.toBeOnTheScreen();
  expect(screen.queryByText('All Teams')).not.toBeOnTheScreen();
});
