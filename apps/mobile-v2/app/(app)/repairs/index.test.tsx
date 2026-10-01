// Render tests for the Repairs list screen.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';
import RepairsScreen from './index';

function seedRepair(id: string, label: string, extra: Record<string, unknown> = {}) {
  seed('repairs', {
    id, entity_type: 'equipment_unit', entity_id: `unit-${id}`, entity_label: label,
    status: 'Open', created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...extra,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the open empty state when there are no repairs', async () => {
  await renderScreen(<RepairsScreen />);
  expect(screen.getByText('No repairs')).toBeOnTheScreen();
  expect(screen.getByText('No open repair tickets.')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<RepairsScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Repairs', headerShown: true }),
  );
});

test('the default Open filter lists open tickets and hides completed ones', async () => {
  seedRepair('r1', 'Air Mover AM-001');
  seedRepair('r2', 'Dehu DH-002', { status: 'Done', completed_at: '2026-01-02T00:00:00Z' });
  await renderScreen(<RepairsScreen />);
  expect(screen.getByText('Air Mover AM-001')).toBeOnTheScreen();
  expect(screen.queryByText('Dehu DH-002')).not.toBeOnTheScreen();
});

test('the Done and All filters change what is listed', async () => {
  seedRepair('r1', 'Air Mover AM-001');
  seedRepair('r2', 'Dehu DH-002', { status: 'Done', completed_at: '2026-01-02T00:00:00Z' });
  await renderScreen(<RepairsScreen />);

  await fireEvent.press(screen.getByText('Done'));
  expect(screen.getByText('Dehu DH-002')).toBeOnTheScreen();
  expect(screen.queryByText('Air Mover AM-001')).not.toBeOnTheScreen();

  await fireEvent.press(screen.getByText('All'));
  expect(screen.getByText('Dehu DH-002')).toBeOnTheScreen();
  expect(screen.getByText('Air Mover AM-001')).toBeOnTheScreen();
});

test('flags an open ticket past its due date as Overdue', async () => {
  seedRepair('r1', 'Air Mover AM-001', { due_at: '2020-01-01T00:00:00Z' });
  await renderScreen(<RepairsScreen />);
  expect(screen.getByText('Overdue')).toBeOnTheScreen();
});

test('hides the New repair FAB when the user cannot edit inventory', async () => {
  await renderScreen(<RepairsScreen />, { permissions: { edit_inventory: false } });
  expect(screen.queryByLabelText('New repair')).not.toBeOnTheScreen();
});

test('the New repair FAB opens the repair quick-add sheet', async () => {
  await renderScreen(<RepairsScreen />);
  await fireEvent.press(screen.getByLabelText('New repair'));
  expect(navCalls).toContainEqual({
    method: 'push',
    args: [{ pathname: '/(app)/quickadd/[sheet]', params: { sheet: 'repair' } }],
  });
});

test('tapping a ticket navigates to its detail route', async () => {
  seedRepair('r1', 'Air Mover AM-001');
  await renderScreen(<RepairsScreen />);
  await fireEvent.press(screen.getByText('Air Mover AM-001'));
  expect(navCalls).toContainEqual({
    method: 'push',
    args: [{ pathname: '/(app)/repairs/[id]', params: { id: 'r1' } }],
  });
});
