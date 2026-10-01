// Render tests for Settings -> Security.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb, getDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';

import SecuritySettings from './security';

jest.mock('../../../src/auth/session', () => ({ getValidJwt: jest.fn(async () => null) }));

beforeEach(async () => { await initPageDb(); });

function setting(key: string) {
  const r = getDb().executeSync('SELECT value FROM app_settings WHERE key = ?', [key]).rows as { value: string }[];
  return r[0]?.value;
}

test('renders the idle auto-logout options for an admin', async () => {
  await renderScreen(<SecuritySettings />);
  expect(screen.getByText('Idle Auto-logout')).toBeOnTheScreen();
  for (const l of ['Off', '5 min', '15 min', '30 min']) expect(screen.getByText(l)).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<SecuritySettings />);
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Security' }));
});

test('tier-4 admin sees the System block incl. maintenance and demo accounts', async () => {
  await renderScreen(<SecuritySettings />);
  expect(screen.getByText('System')).toBeOnTheScreen();
  expect(screen.getByText(/Maintenance mode/)).toBeOnTheScreen();
  expect(screen.getByText(/Demo accounts/)).toBeOnTheScreen();
});

test('a non-tier-4 role only sees idle auto-logout', async () => {
  await renderScreen(<SecuritySettings />, { role: 'contents_crew' });
  expect(screen.getByText('Idle Auto-logout')).toBeOnTheScreen();
  expect(screen.queryByText('System')).not.toBeOnTheScreen();
  expect(screen.queryByText(/Maintenance mode/)).not.toBeOnTheScreen();
});

test('demo accounts is apex-only: hidden for a tier-4 non-full_admin', async () => {
  await renderScreen(<SecuritySettings />, { role: 'franchise_manager' });
  expect(screen.getByText(/Maintenance mode/)).toBeOnTheScreen();
  expect(screen.queryByText(/Demo accounts/)).not.toBeOnTheScreen();
});

test('picking an idle timeout persists it', async () => {
  await renderScreen(<SecuritySettings />);
  await fireEvent.press(screen.getByText('15 min'));
  expect(setting('idle_timeout_minutes')).toBe('15');
});

test('maintenance switch writes app_config and queues an outbox row', async () => {
  await renderScreen(<SecuritySettings />);
  const sw = screen.getAllByRole('switch')[0];
  await fireEvent(sw, 'valueChange', true);
  const cfg = getDb().executeSync("SELECT value FROM app_config WHERE key = 'maintenance_mode'").rows as { value: string }[];
  expect(cfg[0]?.value).toBe('1');
  const ob = getDb().executeSync("SELECT * FROM outbox WHERE table_name = 'app_config'").rows;
  expect(ob.length).toBe(1);
});
