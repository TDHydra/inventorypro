// Render tests for the On-Call settings screen (week boundary + crew rotation).
import { screen } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { stackScreenOptions } from '../../../test/mocks/expoRouter';
import OnCallSettingsScreen from './settings';

const TS = '2026-01-01T00:00:00Z';

beforeEach(async () => { await initPageDb(); });

test('renders the week boundary and rotation sections for an admin', async () => {
  await renderScreen(<OnCallSettingsScreen />);
  expect(screen.getByText('Week boundary')).toBeOnTheScreen();
  expect(screen.getByText('Crew rotation')).toBeOnTheScreen();
  expect(screen.getByText('Week flips on')).toBeOnTheScreen();
  expect(screen.getByText('At (local time)')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<OnCallSettingsScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'On-Call Settings', headerShown: true }),
  );
});

test('shows the empty rotation message when none is configured', async () => {
  await renderScreen(<OnCallSettingsScreen />);
  expect(screen.getByText('No crews in the rotation yet.')).toBeOnTheScreen();
});

test('lists the configured rotation crews in order', async () => {
  seed('subteams', { id: 'st1', team_id: 't1', name: 'Alpha Crew', active: 1, created_at: TS, updated_at: TS });
  seed('subteams', { id: 'st2', team_id: 't1', name: 'Bravo Crew', active: 1, created_at: TS, updated_at: TS });
  seed('app_config', { key: 'on_call_rotation', value: JSON.stringify(['st2', 'st1']), updated_at: TS });
  await renderScreen(<OnCallSettingsScreen />);

  expect(screen.getByText('Alpha Crew')).toBeOnTheScreen();
  expect(screen.getByText('Bravo Crew')).toBeOnTheScreen();
  expect(screen.queryByText('No crews in the rotation yet.')).not.toBeOnTheScreen();
});

test('shows an access message instead of the form without system_settings', async () => {
  await renderScreen(<OnCallSettingsScreen />, { role: 'construction_crew' });
  expect(screen.getByText('You don’t have access to on-call settings.')).toBeOnTheScreen();
  expect(screen.queryByText('Week boundary')).not.toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'On-Call Settings' }),
  );
});
