// Render tests for the Repair detail route ([id] shape — see jobs/[id].test.tsx).
import { screen } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { setRouteParams, stackScreenOptions } from '../../../test/mocks/expoRouter';
import RepairDetailScreen from './[id]';

function seedRepair(id: string, extra: Record<string, unknown> = {}) {
  seed('repairs', {
    id, entity_type: 'equipment_unit', entity_id: 'unit-1', entity_label: 'Air Mover AM-001',
    notes: 'Fan rattles', parts_needed: 'Bearing', status: 'Open',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...extra,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the repair it was routed to', async () => {
  seedRepair('r1');
  setRouteParams({ id: 'r1' });
  await renderScreen(<RepairDetailScreen />);
  expect(screen.getByText('Air Mover AM-001')).toBeOnTheScreen();
  expect(screen.getByText('Equipment unit')).toBeOnTheScreen();
  expect(screen.getByDisplayValue('Fan rattles')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Repair', headerShown: true }),
  );
});

test('shows a not-found state when the id does not resolve', async () => {
  setRouteParams({ id: 'does-not-exist' });
  await renderScreen(<RepairDetailScreen />);
  expect(screen.getByText('Repair not found')).toBeOnTheScreen();
});

test('shows the Overdue badge for an open ticket past its due date', async () => {
  seedRepair('r1', { due_at: '2020-01-01T00:00:00Z' });
  setRouteParams({ id: 'r1' });
  await renderScreen(<RepairDetailScreen />);
  expect(screen.getAllByText('Overdue').length).toBeGreaterThan(0);
});

test('shows who the ticket is assigned to', async () => {
  seed('users', {
    id: 'u1', name: 'Dana Tech', role: 'technician', pin_length_required: 4, active: 1,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  });
  seedRepair('r1', { assignee_id: 'u1' });
  setRouteParams({ id: 'r1' });
  await renderScreen(<RepairDetailScreen />);
  expect(screen.getByText('Assigned to Dana Tech')).toBeOnTheScreen();
});

test('a user without edit rights sees the read-only note', async () => {
  seedRepair('r1');
  setRouteParams({ id: 'r1' });
  await renderScreen(<RepairDetailScreen />, { permissions: { edit_inventory: false } });
  expect(screen.getByText('You do not have permission to edit this repair.')).toBeOnTheScreen();
});

test('an editor does not see the read-only note', async () => {
  seedRepair('r1');
  setRouteParams({ id: 'r1' });
  await renderScreen(<RepairDetailScreen />);
  expect(screen.queryByText('You do not have permission to edit this repair.')).not.toBeOnTheScreen();
});

test('cost is hidden without view_financial_data and shown with it', async () => {
  seedRepair('r1', { cost: 42.5 });
  setRouteParams({ id: 'r1' });
  await renderScreen(<RepairDetailScreen />, { permissions: { view_financial_data: false } });
  expect(screen.queryByText('Cost')).not.toBeOnTheScreen();
});

test('cost field is shown to an admin', async () => {
  seedRepair('r1', { cost: 42.5 });
  setRouteParams({ id: 'r1' });
  await renderScreen(<RepairDetailScreen />);
  expect(screen.getByText('Cost')).toBeOnTheScreen();
  expect(screen.getByDisplayValue('42.5')).toBeOnTheScreen();
});
