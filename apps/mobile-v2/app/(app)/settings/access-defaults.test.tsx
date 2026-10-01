// Render tests for Settings -> Unit Access Defaults.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb, getDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';

import UnitAccessDefaultsSettings from './access-defaults';
import { ROLE_TIER } from '../../../src/constants/roles';

beforeEach(async () => { await initPageDb(); });

test('renders a card of six switches for every role', async () => {
  await renderScreen(<UnitAccessDefaultsSettings />);
  expect(screen.getByText('New-grant defaults per role')).toBeOnTheScreen();
  expect(screen.getAllByRole('switch').length).toBe(Object.keys(ROLE_TIER).length * 6);
  expect(screen.getAllByText('Grant access to others').length).toBe(Object.keys(ROLE_TIER).length);
});

test('sets the native header title', async () => {
  await renderScreen(<UnitAccessDefaultsSettings />);
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Unit Access Defaults' }));
});

test('without system_settings shows the no-access message', async () => {
  await renderScreen(<UnitAccessDefaultsSettings />, { role: 'contents_crew' });
  expect(screen.getByText(/don't have access to unit access defaults/)).toBeOnTheScreen();
  expect(screen.queryByRole('switch')).not.toBeOnTheScreen();
});

test('toggling a switch persists unit_access_defaults and queues an outbox row', async () => {
  await renderScreen(<UnitAccessDefaultsSettings />);
  const sw = screen.getAllByRole('switch')[0];
  await fireEvent(sw, 'valueChange', !sw.props.value);
  const cfg = getDb().executeSync("SELECT value FROM app_config WHERE key = 'unit_access_defaults'").rows as { value: string }[];
  expect(cfg.length).toBe(1);
  const ob = getDb().executeSync("SELECT * FROM outbox WHERE table_name = 'app_config'").rows;
  expect(ob.length).toBe(1);
});
