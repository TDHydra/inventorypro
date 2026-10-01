// Render tests for the Job detail route. Second reference example for the page
// harness: this is the `[id]` shape, where the screen reads its target from
// useLocalSearchParams — set it with setRouteParams() BEFORE rendering.
import { screen } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { setRouteParams } from '../../../test/mocks/expoRouter';
import JobDetailScreen from './[id]';

function seedJob(id: string, fields: Record<string, unknown> = {}) {
  seed('jobs', {
    id,
    name: 'Roof Replacement',
    status: 'active',
    created_by: 'user-1',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    job_number: 1042,
    customer_name: 'Acme Co',
    ...fields,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the job it was routed to', async () => {
  seedJob('job-1');
  setRouteParams({ id: 'job-1' });
  await renderScreen(<JobDetailScreen />);
  expect(screen.getByText(/Roof Replacement/)).toBeOnTheScreen();
});

test('renders without crashing when the id does not resolve to a job', async () => {
  // A job can be archived or deleted on another device between the list render
  // and the tap, so the detail route must tolerate a missing row.
  setRouteParams({ id: 'does-not-exist' });
  await renderScreen(<JobDetailScreen />);
  expect(screen.queryByText(/Roof Replacement/)).not.toBeOnTheScreen();
});
