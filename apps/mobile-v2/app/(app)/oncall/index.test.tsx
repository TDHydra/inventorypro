// Render tests for the On-Call screen (week grid + coverage list).
import { screen } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { stackScreenOptions } from '../../../test/mocks/expoRouter';
import OnCallScreen from './index';

const TS = '2026-01-01T00:00:00Z';

function isoPlusDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function seedUser(id: string, name: string) {
  seed('users', {
    id, name, role: 'construction_crew', pin_length_required: 4, active: 1,
    created_at: TS, updated_at: TS,
  });
}

function seedCoverage(id: string, extra: Record<string, unknown> = {}) {
  seed('on_call_coverage', {
    id, date_start: isoPlusDays(2), date_end: isoPlusDays(3),
    user_off: 'u-off', covering_user: 'u-cover', created_at: TS, updated_at: TS, ...extra,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the week grid and coverage empty state', async () => {
  await renderScreen(<OnCallScreen />);
  expect(screen.getByText('Week grid')).toBeOnTheScreen();
  expect(screen.getByText('Coverage')).toBeOnTheScreen();
  expect(screen.getByText('No coverage entries')).toBeOnTheScreen();
});

test('sets the native header title and a Settings link for admins', async () => {
  await renderScreen(<OnCallScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'On-Call', headerShown: true, headerRight: expect.any(Function) }),
  );
});

test('omits the Settings header link without system_settings', async () => {
  await renderScreen(<OnCallScreen />, { role: 'construction_crew' });
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'On-Call', headerRight: undefined }),
  );
});

test('lists coverage entries with resolved user names and note', async () => {
  seedUser('u-off', 'Olivia Off');
  seedUser('u-cover', 'Carl Cover');
  seedCoverage('c1', { note: 'Back Monday' });
  await renderScreen(<OnCallScreen />);

  expect(screen.getByText('Carl Cover covering for Olivia Off')).toBeOnTheScreen();
  expect(screen.getByText('Back Monday')).toBeOnTheScreen();
  expect(screen.queryByText('No coverage entries')).not.toBeOnTheScreen();
});

test('excludes coverage that ended before the 30-day look-back window', async () => {
  seedUser('u-off', 'Olivia Off');
  seedUser('u-cover', 'Carl Cover');
  seedCoverage('c1', { date_start: isoPlusDays(-90), date_end: isoPlusDays(-80), note: 'Ancient note' });
  await renderScreen(<OnCallScreen />);

  expect(screen.queryByText('Ancient note')).not.toBeOnTheScreen();
  expect(screen.getByText('No coverage entries')).toBeOnTheScreen();
});

test('an editor sees the Add Coverage button and edit hint', async () => {
  await renderScreen(<OnCallScreen />);
  expect(screen.getByLabelText('Add Coverage')).toBeOnTheScreen();
  expect(screen.getByText('Tap a row to edit or delete it.')).toBeOnTheScreen();
});

test('without manage_teams the coverage list is read-only', async () => {
  await renderScreen(<OnCallScreen />, { permissions: { manage_teams: false } });
  expect(screen.queryByLabelText('Add Coverage')).not.toBeOnTheScreen();
  expect(screen.getByText('Coverage entries are read-only for your role.')).toBeOnTheScreen();
});
