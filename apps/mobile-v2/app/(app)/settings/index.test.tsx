// Render tests for the Settings hub (mostly navigation).
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb, getDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';

import SettingsHub from './index';

beforeEach(async () => { await initPageDb(); });

test('renders account block and sections for the signed-in user', async () => {
  await renderScreen(<SettingsHub />);
  expect(screen.getByText('Dev Tester')).toBeOnTheScreen();
  expect(screen.getByText('Full Admin')).toBeOnTheScreen();
  expect(screen.getByText('Log out')).toBeOnTheScreen();
  expect(screen.getByText('More Settings')).toBeOnTheScreen();
  expect(screen.getByText('User ID: user-1')).toBeOnTheScreen();
});

test('renders nothing when signed out', async () => {
  await renderScreen(<SettingsHub />, { user: null });
  expect(screen.queryByText('Account')).not.toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<SettingsHub />);
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Settings' }));
});

test('admin sees the admin-only links', async () => {
  await renderScreen(<SettingsHub />);
  expect(screen.getByText(/Organization/)).toBeOnTheScreen();
  expect(screen.getByText(/Hidden Fields/)).toBeOnTheScreen();
  expect(screen.getByText(/Unit Access Defaults/)).toBeOnTheScreen();
});

test('without system_settings the admin links are hidden but personal links remain', async () => {
  await renderScreen(<SettingsHub />, { role: 'contents_crew' });
  expect(screen.getByText(/Sync & Data/)).toBeOnTheScreen();
  expect(screen.getByText(/Security/)).toBeOnTheScreen();
  expect(screen.queryByText(/Organization/)).not.toBeOnTheScreen();
  expect(screen.queryByText(/Hidden Fields/)).not.toBeOnTheScreen();
  expect(screen.queryByText(/Unit Access Defaults/)).not.toBeOnTheScreen();
});

test.each([
  [/Sync & Data/, '/(app)/settings/sync'],
  [/Notifications/, '/(app)/settings/notifications'],
  [/Security/, '/(app)/settings/security'],
  [/Organization/, '/(app)/settings/org'],
  [/Hidden Fields/, '/(app)/settings/fields'],
  [/Unit Access Defaults/, '/(app)/settings/access-defaults'],
])('tapping %s pushes %s', async (label, href) => {
  await renderScreen(<SettingsHub />);
  await fireEvent.press(screen.getByText(label));
  expect(navCalls).toContainEqual({ method: 'push', args: [href] });
});

test('tapping a theme row writes the user pref', async () => {
  await renderScreen(<SettingsHub />);
  await fireEvent.press(screen.getByText('Classic'));
  const rows = getDb().executeSync('SELECT * FROM user_prefs').rows;
  expect(rows.length).toBe(1);
});

test('form-detail override chips update the effective mode', async () => {
  await renderScreen(<SettingsHub />);
  await fireEvent.press(screen.getByText('Simple'));
  expect(screen.getByText('Effective: Simple')).toBeOnTheScreen();
  await fireEvent.press(screen.getByText('Detailed'));
  expect(screen.getByText('Effective: Detailed')).toBeOnTheScreen();
});
