// Render tests for the Equipment model detail route ([id] shape — see jobs/[id].test.tsx).
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { navCalls, setRouteParams, stackScreenOptions } from '../../../test/mocks/expoRouter';
import EquipmentDetailScreen from './[id]';

const TS = '2026-01-01T00:00:00Z';

function seedModel(id: string, extra: Record<string, unknown> = {}) {
  seed('inventory_items', {
    id, name: 'Air Mover', kind: 'equipment', unit_category: 'piece', unit: 'each',
    unit_tracked: 1, active: 1, updated_at: TS, ...extra,
  });
}

function seedUnit(id: string, itemId: string, status: string, extra: Record<string, unknown> = {}) {
  seed('equipment_units', {
    id, item_id: itemId, asset_tag: `AM-${id}`, status, created_at: TS, updated_at: TS, ...extra,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the model it was routed to', async () => {
  seedModel('m1', { description: 'High-velocity fan', tag_prefix: 'AM-' });
  setRouteParams({ id: 'm1' });
  await renderScreen(<EquipmentDetailScreen />);

  expect(screen.getByText('Air Mover')).toBeOnTheScreen();
  expect(screen.getByText('High-velocity fan')).toBeOnTheScreen();
  expect(screen.getByText('Tag prefix')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Air Mover', headerShown: true }),
  );
});

test('shows a not-found state when the id does not resolve', async () => {
  setRouteParams({ id: 'does-not-exist' });
  await renderScreen(<EquipmentDetailScreen />);
  expect(screen.getByText('Equipment model not found.')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Equipment', headerShown: true }),
  );
});

test('shows the empty unit and maintenance states for a model with no units', async () => {
  seedModel('m1');
  setRouteParams({ id: 'm1' });
  await renderScreen(<EquipmentDetailScreen />);

  expect(screen.getByText('No units registered yet.')).toBeOnTheScreen();
  expect(screen.getByText('No maintenance logged for this model.')).toBeOnTheScreen();
  expect(screen.getByText(/0 available/)).toBeOnTheScreen();
});

test('lists registered units with the status summary, only for this model', async () => {
  seedModel('m1');
  seedModel('m2', { name: 'Dehumidifier' });
  seedUnit('001', 'm1', 'available');
  seedUnit('002', 'm1', 'deployed');
  seedUnit('003', 'm2', 'available');
  setRouteParams({ id: 'm1' });
  await renderScreen(<EquipmentDetailScreen />);

  expect(screen.getByText(/1 available · 1 deployed/)).toBeOnTheScreen();
  expect(screen.getByText(/AM-001/)).toBeOnTheScreen();
  expect(screen.getByText(/AM-002/)).toBeOnTheScreen();
  expect(screen.queryByText(/AM-003/)).not.toBeOnTheScreen();
});

test('an editor sees Add Units, Edit Model and per-unit Edit/Retire', async () => {
  seedModel('m1');
  seedUnit('001', 'm1', 'available');
  setRouteParams({ id: 'm1' });
  await renderScreen(<EquipmentDetailScreen />);

  expect(screen.getByText('+ Add Units')).toBeOnTheScreen();
  expect(screen.getByText('Edit Model')).toBeOnTheScreen();
  expect(screen.getByText('Retire')).toBeOnTheScreen();
  expect(screen.getByText('Report repair')).toBeOnTheScreen();
});

test('hides the edit and add affordances without edit/add inventory permission', async () => {
  seedModel('m1');
  seedUnit('001', 'm1', 'available');
  setRouteParams({ id: 'm1' });
  await renderScreen(<EquipmentDetailScreen />, {
    permissions: { edit_inventory: false, add_inventory: false },
  });

  expect(screen.queryByText('+ Add Units')).not.toBeOnTheScreen();
  expect(screen.queryByText('Edit Model')).not.toBeOnTheScreen();
  expect(screen.queryByText('Retire')).not.toBeOnTheScreen();
  expect(screen.queryByText('Report repair')).not.toBeOnTheScreen();
  // Read-only actions stay.
  expect(screen.getByText('History')).toBeOnTheScreen();
});

test('Report repair routes into the repair quick-add sheet pre-filled with the unit', async () => {
  seedModel('m1');
  seedUnit('001', 'm1', 'available');
  setRouteParams({ id: 'm1' });
  await renderScreen(<EquipmentDetailScreen />);

  await fireEvent.press(screen.getByText('Report repair'));
  expect(navCalls).toContainEqual({
    method: 'push',
    args: [{
      pathname: '/(app)/quickadd/[sheet]',
      params: { sheet: 'repair', entityType: 'equipment_unit', entityId: '001', entityLabel: 'AM-001' },
    }],
  });
});

test('Edit Model swaps the header card for the edit form', async () => {
  seedModel('m1');
  setRouteParams({ id: 'm1' });
  await renderScreen(<EquipmentDetailScreen />);

  await fireEvent.press(screen.getByText('Edit Model'));
  expect(screen.getByText('Save Changes')).toBeOnTheScreen();
  expect(screen.getByDisplayValue('Air Mover')).toBeOnTheScreen();
});
