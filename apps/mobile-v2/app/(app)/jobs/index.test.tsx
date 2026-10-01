// Render tests for the Jobs list screen (My Checkouts / All Jobs tabs).
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';
import JobsScreen from './index';

const TS = '2026-01-01T00:00:00Z';

function seedJob(id: string, name: string, status = 'open', extra: Record<string, unknown> = {}) {
  seed('jobs', { id, name, status, created_by: 'user-1', created_at: TS, updated_at: TS, ...extra });
}

async function openAllJobs() {
  await fireEvent.press(screen.getByText('All Jobs'));
}

beforeEach(async () => { await initPageDb(); });

test('renders the My Checkouts empty state by default', async () => {
  await renderScreen(<JobsScreen />);
  expect(screen.getByText('My Checkouts')).toBeOnTheScreen();
  expect(screen.getByText('No active checkouts')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<JobsScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Jobs', headerShown: true }),
  );
});

test('All Jobs tab shows its empty state with zero jobs', async () => {
  await renderScreen(<JobsScreen />);
  await openAllJobs();
  expect(screen.getByText('No jobs found')).toBeOnTheScreen();
});

test('All Jobs lists open jobs and hides closed and archived ones by default', async () => {
  seedJob('j1', 'Roof Replacement');
  seedJob('j2', 'Kitchen Remodel');
  seedJob('j3', 'Old Closed Job', 'closed');
  seedJob('j4', 'Archived Job', 'archived');
  await renderScreen(<JobsScreen />);
  await openAllJobs();

  expect(screen.getByText('Roof Replacement')).toBeOnTheScreen();
  expect(screen.getByText('Kitchen Remodel')).toBeOnTheScreen();
  expect(screen.queryByText('Old Closed Job')).not.toBeOnTheScreen();
  expect(screen.queryByText('Archived Job')).not.toBeOnTheScreen();
});

test('the Closed status chip swaps the list to closed jobs', async () => {
  seedJob('j1', 'Roof Replacement');
  seedJob('j3', 'Old Closed Job', 'closed');
  await renderScreen(<JobsScreen />);
  await openAllJobs();

  await fireEvent.press(screen.getByText('Closed'));
  expect(screen.getByText('Old Closed Job')).toBeOnTheScreen();
  expect(screen.queryByText('Roof Replacement')).not.toBeOnTheScreen();
});

test('tapping a job row navigates to its detail route', async () => {
  seedJob('j1', 'Roof Replacement');
  await renderScreen(<JobsScreen />);
  await openAllJobs();

  await fireEvent.press(screen.getByText('Roof Replacement'));
  expect(navCalls).toContainEqual({
    method: 'push',
    args: [{ pathname: '/(app)/jobs/[id]', params: { id: 'j1' } }],
  });
});

test('shows the New Job button for a user who can create jobs', async () => {
  await renderScreen(<JobsScreen />);
  expect(screen.getByLabelText('New Job')).toBeOnTheScreen();
});

test('hides the New Job button when create_jobs is denied', async () => {
  await renderScreen(<JobsScreen />, { permissions: { create_jobs: false } });
  expect(screen.queryByLabelText('New Job')).not.toBeOnTheScreen();
});
