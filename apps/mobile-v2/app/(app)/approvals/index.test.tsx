// Render tests for the Approvals worklist screen.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb, getDb } from '../../../test/pageTestDb';
import { stackScreenOptions } from '../../../test/mocks/expoRouter';
import ApprovalsScreen from './index';

const TS = '2026-01-01T00:00:00Z';

function seedApproval(id: string, title: string, status = 'open', extra: Record<string, unknown> = {}) {
  seed('approval_requests', {
    id, requester_id: 'u-req', kind: 'time_off', title, status,
    created_at: TS, updated_at: TS, ...extra,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the empty state when nothing is pending', async () => {
  await renderScreen(<ApprovalsScreen />);
  expect(screen.getByText('Nothing pending')).toBeOnTheScreen();
  expect(screen.getByText('Approval requests will show up here.')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<ApprovalsScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Approvals', headerShown: true }),
  );
});

test('lists open requests with detail, and omits decided ones', async () => {
  seedApproval('a1', 'Friday off', 'open', { detail: 'Dentist appointment' });
  seedApproval('a2', 'Truck purchase', 'open');
  seedApproval('a3', 'Already handled', 'approved');
  await renderScreen(<ApprovalsScreen />);

  expect(screen.getByText('Friday off')).toBeOnTheScreen();
  expect(screen.getByText('Dentist appointment')).toBeOnTheScreen();
  expect(screen.getByText('Truck purchase')).toBeOnTheScreen();
  expect(screen.queryByText('Already handled')).not.toBeOnTheScreen();
});

test('shows Approve and Deny buttons to a user with manage_teams', async () => {
  seedApproval('a1', 'Friday off');
  await renderScreen(<ApprovalsScreen />);
  expect(screen.getByText('Approve')).toBeOnTheScreen();
  expect(screen.getByText('Deny')).toBeOnTheScreen();
});

test('hides Approve and Deny when manage_teams is denied', async () => {
  seedApproval('a1', 'Friday off');
  await renderScreen(<ApprovalsScreen />, { permissions: { manage_teams: false } });
  expect(screen.getByText('Friday off')).toBeOnTheScreen();
  expect(screen.queryByText('Approve')).not.toBeOnTheScreen();
  expect(screen.queryByText('Deny')).not.toBeOnTheScreen();
});

test('pressing Approve marks the request approved in the database', async () => {
  seedApproval('a1', 'Friday off');
  await renderScreen(<ApprovalsScreen />);
  await fireEvent.press(screen.getByText('Approve'));

  const rows = getDb().executeSync(`SELECT status, decided_by FROM approval_requests WHERE id = 'a1'`).rows as any[];
  expect(rows[0].status).toBe('approved');
  expect(rows[0].decided_by).toBe('user-1');
});
