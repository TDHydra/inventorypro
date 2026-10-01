// Render tests for Settings -> Notifications.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb, getDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';

import NotificationSettings from './notifications';

jest.mock('../../../src/notifications/localAlerts', () => ({
  ensureNotificationPermission: jest.fn(async () => true),
}));

beforeEach(async () => { await initPageDb(); });

test('renders the personal sections', async () => {
  await renderScreen(<NotificationSettings />);
  expect(screen.getByText('This device')).toBeOnTheScreen();
  expect(screen.getByText('Quiet hours')).toBeOnTheScreen();
  expect(screen.getByText('What buzzes my phone')).toBeOnTheScreen();
  expect(screen.getByText('Assignments')).toBeOnTheScreen();
  expect(screen.getByText('Announcements')).toBeOnTheScreen();
});

test('renders nothing when signed out', async () => {
  await renderScreen(<NotificationSettings />, { user: null });
  expect(screen.queryByText('This device')).not.toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<NotificationSettings />);
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Notifications' }));
});

test('admin sees trigger config, routing and on-call link', async () => {
  await renderScreen(<NotificationSettings />);
  expect(screen.getByText('Notification Triggers')).toBeOnTheScreen();
  expect(screen.getByText('Who gets notified')).toBeOnTheScreen();
  expect(screen.getByText(/On-Call Settings/)).toBeOnTheScreen();
});

test('without system_settings the admin sections are hidden', async () => {
  await renderScreen(<NotificationSettings />, { role: 'contents_crew' });
  expect(screen.getByText('Quiet hours')).toBeOnTheScreen();
  expect(screen.queryByText('Notification Triggers')).not.toBeOnTheScreen();
  expect(screen.queryByText('Who gets notified')).not.toBeOnTheScreen();
  expect(screen.queryByText(/On-Call Settings/)).not.toBeOnTheScreen();
});

test('On-Call Settings pushes the oncall settings route', async () => {
  await renderScreen(<NotificationSettings />);
  await fireEvent.press(screen.getByText(/On-Call Settings/));
  expect(navCalls).toContainEqual({ method: 'push', args: ['/(app)/oncall/settings'] });
});

test('a quiet-hours preset persists to user_prefs', async () => {
  await renderScreen(<NotificationSettings />);
  await fireEvent.press(screen.getByText('10 PM – 6 AM'));
  const rows = getDb().executeSync('SELECT * FROM user_prefs').rows as Record<string, unknown>[];
  expect(rows.length).toBe(1);
});

test('toggling push triggers off writes notify_enabled=0 through the outbox', async () => {
  await renderScreen(<NotificationSettings />);
  // Switch order: device, then 7 categories, then the trigger switch.
  const switches = screen.getAllByRole('switch');
  await fireEvent(switches[8], 'valueChange', false);
  const cfg = getDb().executeSync("SELECT value FROM app_config WHERE key = 'notify_enabled'").rows as { value: string }[];
  expect(cfg[0]?.value).toBe('0');
  const ob = getDb().executeSync("SELECT * FROM outbox WHERE table_name = 'app_config'").rows;
  expect(ob.length).toBeGreaterThan(0);
});
