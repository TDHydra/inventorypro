// Render tests for Settings -> Organization.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb, getDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';

import OrgSettings from './org';

beforeEach(async () => { await initPageDb(); });

test('renders every org-wide section for an admin', async () => {
  await renderScreen(<OrgSettings />);
  expect(screen.getByText('Org default theme')).toBeOnTheScreen();
  expect(screen.getByText('Default form mode')).toBeOnTheScreen();
  expect(screen.getByText('Main storage area')).toBeOnTheScreen();
  expect(screen.getByText('Approvals')).toBeOnTheScreen();
  expect(screen.getByText(/Manage Types/)).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<OrgSettings />);
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Organization' }));
});

test('without system_settings shows the no-access message', async () => {
  await renderScreen(<OrgSettings />, { role: 'contents_crew' });
  expect(screen.getByText(/don't have access to organization settings/)).toBeOnTheScreen();
  expect(screen.queryByText('Org default theme')).not.toBeOnTheScreen();
});

test('Manage Types pushes its route', async () => {
  await renderScreen(<OrgSettings />);
  await fireEvent.press(screen.getByText(/Manage Types/));
  expect(navCalls).toContainEqual({ method: 'push', args: ['/(app)/manage-types'] });
});

test('picking the default form mode writes app_config and queues an outbox row', async () => {
  await renderScreen(<OrgSettings />);
  await fireEvent.press(screen.getByText('Simple'));
  const cfg = getDb().executeSync("SELECT value FROM app_config WHERE key = 'form_mode_default'").rows as { value: string }[];
  expect(cfg[0]?.value).toBe('simple');
  const ob = getDb().executeSync("SELECT * FROM outbox WHERE table_name = 'app_config'").rows;
  expect(ob.length).toBe(1);
});

test('picking an org theme writes it to app_config', async () => {
  await renderScreen(<OrgSettings />);
  await fireEvent.press(screen.getByText('Classic'));
  const cfg = getDb().executeSync("SELECT * FROM app_config WHERE value = 'classic' OR key LIKE '%theme%'").rows;
  expect(cfg.length).toBeGreaterThan(0);
});

test('a seeded approval threshold prefills the input', async () => {
  seed('app_config', { key: 'approval_threshold_qty', value: '25', updated_at: '2026-01-01T00:00:00Z' });
  await renderScreen(<OrgSettings />);
  expect(screen.getByDisplayValue('25')).toBeOnTheScreen();
});
