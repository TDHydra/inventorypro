// Render tests for the Schedule route (thin wrapper over DayBoardScreen).
import { screen } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { stackScreenOptions } from '../../../test/mocks/expoRouter';
import ScheduleRoute from './index';

const TS = '2026-01-01T00:00:00Z';

function seedUser(id: string, name: string, role: string, extra: Record<string, unknown> = {}) {
  seed('users', {
    id, name, role, pin_length_required: 4, active: 1, created_at: TS, updated_at: TS, ...extra,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the empty state when there is no field crew', async () => {
  await renderScreen(<ScheduleRoute />);
  expect(screen.getByText('No field crew to schedule')).toBeOnTheScreen();
  expect(screen.getByText('Active crew members will appear here.')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<ScheduleRoute />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Schedule', headerShown: true }),
  );
});

test('lists active field crew (tier 1) on the board', async () => {
  seedUser('u1', 'Casey Crew', 'construction_crew');
  seedUser('u2', 'Tina Temp', 'temporary_employee');
  await renderScreen(<ScheduleRoute />);

  expect(screen.getByText('Casey Crew')).toBeOnTheScreen();
  expect(screen.getByText('Tina Temp')).toBeOnTheScreen();
  expect(screen.queryByText('No field crew to schedule')).not.toBeOnTheScreen();
});

test('does not list managers or inactive crew', async () => {
  seedUser('u1', 'Casey Crew', 'construction_crew');
  seedUser('u2', 'Pat Production', 'production_manager');
  seedUser('u3', 'Gone Crew', 'construction_crew', { active: 0 });
  await renderScreen(<ScheduleRoute />);

  expect(screen.getByText('Casey Crew')).toBeOnTheScreen();
  expect(screen.queryByText('Pat Production')).not.toBeOnTheScreen();
  expect(screen.queryByText('Gone Crew')).not.toBeOnTheScreen();
});

test('schedule editors get the expand-hours toggle', async () => {
  await renderScreen(<ScheduleRoute />);
  expect(screen.getByText('⇥ Expand hours (5a–9p)')).toBeOnTheScreen();
});

test('viewers without manage_schedule do not get the expand-hours toggle on an empty day', async () => {
  await renderScreen(<ScheduleRoute />, { permissions: { manage_schedule: false } });
  expect(screen.queryByText('⇥ Expand hours (5a–9p)')).not.toBeOnTheScreen();
});
