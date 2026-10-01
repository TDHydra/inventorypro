// Render tests for the Equipment models list screen.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';
import EquipmentScreen from './index';

function seedModel(id: string, name: string, extra: Record<string, unknown> = {}) {
  seed('inventory_items', {
    id, name, kind: 'equipment', unit_category: 'piece', unit: 'each',
    active: 1, updated_at: '2026-01-01T00:00:00Z', ...extra,
  });
}

function seedUnit(id: string, itemId: string, status: string) {
  seed('equipment_units', {
    id, item_id: itemId, asset_tag: `TAG-${id}`, status,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the empty state when there are no equipment models', async () => {
  await renderScreen(<EquipmentScreen />);
  expect(screen.getByText('No equipment models')).toBeOnTheScreen();
  expect(screen.getByText('Add your first equipment model to get started.')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<EquipmentScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Equipment', headerShown: true }),
  );
});

test('lists equipment models with unit-status chips, and not plain products', async () => {
  seedModel('m1', 'Air Mover');
  seedModel('m2', 'Dehumidifier');
  seedModel('p1', 'Duct Tape', { kind: 'product' });
  seedUnit('u1', 'm1', 'available');
  seedUnit('u2', 'm1', 'deployed');
  await renderScreen(<EquipmentScreen />);

  expect(screen.getByText('Air Mover')).toBeOnTheScreen();
  expect(screen.getByText('Dehumidifier')).toBeOnTheScreen();
  expect(screen.queryByText('Duct Tape')).not.toBeOnTheScreen();
  expect(screen.getByText('1 avail')).toBeOnTheScreen();
  expect(screen.getByText('1 out')).toBeOnTheScreen();
  // m2 has no units.
  expect(screen.getByText('No units')).toBeOnTheScreen();
});

test('hides the add affordances when the user cannot add inventory', async () => {
  await renderScreen(<EquipmentScreen />, { permissions: { add_inventory: false } });
  expect(screen.queryByLabelText('Add equipment model')).not.toBeOnTheScreen();
  expect(screen.queryByText('＋ Add Equipment')).not.toBeOnTheScreen();
});

test('shows the add affordance for an admin and opens the new-model sheet', async () => {
  await renderScreen(<EquipmentScreen />);
  await fireEvent.press(screen.getByLabelText('Add equipment model'));
  expect(screen.getByText('New Equipment Model')).toBeOnTheScreen();
});

test('tapping a model row navigates to its detail route', async () => {
  seedModel('m1', 'Air Mover');
  await renderScreen(<EquipmentScreen />);
  await fireEvent.press(screen.getByText('Air Mover'));
  expect(navCalls).toContainEqual({
    method: 'push',
    args: [{ pathname: '/(app)/equipment/[id]', params: { id: 'm1' } }],
  });
});
