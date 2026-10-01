// Render tests for the Inventory item detail route (`[id]` shape).
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { setRouteParams, stackScreenOptions, navCalls } from '../../../test/mocks/expoRouter';
import ItemDetailScreen from './[id]';

function seedItem(id: string, fields: Record<string, unknown> = {}) {
  seed('inventory_items', {
    id, name: 'Safety Glasses', unit_category: 'count', unit: 'piece', kind: 'product',
    active: 1, min_qty_alert: 0, updated_at: '2026-01-01T00:00:00Z', ...fields,
  });
}
function seedStock(itemId: string, locId: string, locName: string, qty: number) {
  seed('locations', { id: locId, name: locName, type: 'Locker', active: 1, updated_at: '2026-01-01T00:00:00Z' });
  seed('stock_by_location', { item_id: itemId, location_id: locId, quantity: qty, updated_at: '2026-01-01T00:00:00Z' });
}

beforeEach(async () => { await initPageDb(); });

test('renders the item it was routed to', async () => {
  seedItem('i1', { supplier: 'Acme Supply', sku: 'SG-100' });
  setRouteParams({ id: 'i1' });
  await renderScreen(<ItemDetailScreen />);
  expect(screen.getByText('Safety Glasses')).toBeOnTheScreen();
  expect(screen.getByText('Acme Supply')).toBeOnTheScreen();
  expect(screen.getByText('SG-100')).toBeOnTheScreen();
});

test('shows "Item not found." when the id does not resolve', async () => {
  setRouteParams({ id: 'does-not-exist' });
  await renderScreen(<ItemDetailScreen />);
  expect(screen.getByText('Item not found.')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Item' }));
});

test('header title is the item name', async () => {
  seedItem('i1');
  setRouteParams({ id: 'i1' });
  await renderScreen(<ItemDetailScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Safety Glasses', headerShown: true }),
  );
});

test('empty stock state when no stock rows exist', async () => {
  seedItem('i1');
  setRouteParams({ id: 'i1' });
  await renderScreen(<ItemDetailScreen />);
  expect(screen.getByText('No stock recorded yet.')).toBeOnTheScreen();
});

test('lists stock by location with admin Adjust / Move actions', async () => {
  seedItem('i1');
  seedStock('i1', 'l1', 'Locker A', 7);
  setRouteParams({ id: 'i1' });
  await renderScreen(<ItemDetailScreen />);
  expect(screen.getByText('Locker A')).toBeOnTheScreen();
  expect(screen.queryByText('No stock recorded yet.')).not.toBeOnTheScreen();
  expect(screen.getByText('Adjust')).toBeOnTheScreen();
  expect(screen.getByText('Move')).toBeOnTheScreen();
  expect(screen.getByText('Edit Item')).toBeOnTheScreen();
});

test('shows the low-stock warning at or below the alert level', async () => {
  seedItem('i1', { min_qty_alert: 10 });
  seedStock('i1', 'l1', 'Locker A', 3);
  setRouteParams({ id: 'i1' });
  await renderScreen(<ItemDetailScreen />);
  expect(screen.getByText(/Low stock — at or below alert of 10/)).toBeOnTheScreen();
});

test('hides edit and stock-mutation affordances without edit_inventory', async () => {
  seedItem('i1');
  seedStock('i1', 'l1', 'Locker A', 7);
  setRouteParams({ id: 'i1' });
  await renderScreen(<ItemDetailScreen />, { permissions: { edit_inventory: false } });
  expect(screen.getByText('Locker A')).toBeOnTheScreen();
  expect(screen.queryByText('Edit Item')).not.toBeOnTheScreen();
  expect(screen.queryByText('Adjust')).not.toBeOnTheScreen();
  expect(screen.queryByText('+ Add stock')).not.toBeOnTheScreen();
  expect(screen.queryByText('Mark needs cleaning')).not.toBeOnTheScreen();
});

test('equipment items redirect to the equipment route', async () => {
  seedItem('i1', { kind: 'equipment' });
  setRouteParams({ id: 'i1' });
  await renderScreen(<ItemDetailScreen />);
  expect(screen.getByText('Opening in Equipment…')).toBeOnTheScreen();
  expect(navCalls).toContainEqual({
    method: 'replace',
    args: [{ pathname: '/(app)/equipment/[id]', params: { id: 'i1' } }],
  });
});

test('Edit Item switches to the edit form and retitles the header', async () => {
  seedItem('i1');
  setRouteParams({ id: 'i1' });
  await renderScreen(<ItemDetailScreen />);
  await fireEvent.press(screen.getByText('Edit Item'));
  expect(screen.getByText('Save Changes')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Edit Item' }));
});
