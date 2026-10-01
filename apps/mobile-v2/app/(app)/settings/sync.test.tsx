// Render tests for Settings -> Sync & Data.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb, getDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';

import SyncSettings from './sync';

beforeEach(async () => { await initPageDb(); });

function outbox(id: string, f: Record<string, unknown> = {}) {
  seed('outbox', {
    id, operation: 'INSERT', table_name: 'jobs', payload: '{}',
    created_at: '2026-01-01T00:00:00Z', attempts: 0, ...f,
  });
}

test('renders status rows with zero counts and no last pull', async () => {
  await renderScreen(<SyncSettings />);
  expect(screen.getByText('Pending changes')).toBeOnTheScreen();
  expect(screen.getByText('Failed (will retry)')).toBeOnTheScreen();
  expect(screen.getByText('Denied by server')).toBeOnTheScreen();
  expect(screen.getByText('never')).toBeOnTheScreen();
  expect(screen.getAllByText('0').length).toBe(3);
  expect(screen.getByText('Sync now')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<SyncSettings />);
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Sync & Data' }));
});

test('counts pending, failed and denied outbox rows separately', async () => {
  outbox('o1');
  outbox('o2');
  outbox('o3', { attempts: 99 });
  outbox('o4', { denied: 1 });
  outbox('o5', { synced_at: '2026-01-02T00:00:00Z' });
  await renderScreen(<SyncSettings />);
  const row = (label: string) => screen.getByText(label).parent!;
  expect(row('Pending changes')).toHaveTextContent('Pending changes2');
  expect(row('Failed (will retry)')).toHaveTextContent('Failed (will retry)1');
  expect(row('Denied by server')).toHaveTextContent('Denied by server1');
});

test('shows the last pull timestamp from app_settings', async () => {
  seed('app_settings', { key: 'last_pulled_at', value: '2026-03-04T05:06:07Z' });
  await renderScreen(<SyncSettings />);
  expect(screen.getByText('2026-03-04T05:06:07Z')).toBeOnTheScreen();
  expect(screen.queryByText('never')).not.toBeOnTheScreen();
});

test('Connectivity row shows a status', async () => {
  await renderScreen(<SyncSettings />);
  expect(screen.getByText('Connectivity')).toBeOnTheScreen();
  expect(screen.getByText(/^(Online|Offline)$/)).toBeOnTheScreen();
});
