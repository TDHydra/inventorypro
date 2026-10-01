// Render tests for the Inventory (item catalog) list screen.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';
import InventoryScreen from './index';


function seedItem(id: string, name: string, extra: Record<string, unknown> = {}) {
  seed('inventory_items', {
    id, name, unit_category: 'count', unit: 'piece', kind: 'product', active: 1,
    updated_at: '2026-01-01T00:00:00Z', ...extra,
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the empty state with an add-to-catalog action for an admin', async () => {
  await renderScreen(<InventoryScreen />);
  expect(screen.getByText('Search or browse items above')).toBeOnTheScreen();
  expect(screen.getByText('+ Add Item to Catalog')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<InventoryScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Inventory', headerShown: true }),
  );
});

test('lists seeded products and excludes equipment rows', async () => {
  seedItem('i1', 'Safety Glasses', { barcode: '111' });
  seedItem('i2', 'Work Gloves');
  seedItem('i3', 'Hydro Pump', { kind: 'equipment' });
  await renderScreen(<InventoryScreen />);

  expect(screen.getByText('Safety Glasses')).toBeOnTheScreen();
  expect(screen.getByText('Work Gloves')).toBeOnTheScreen();
  expect(screen.queryByText('Hydro Pump')).not.toBeOnTheScreen();
});

test('renders a filter chip per item type, plus All', async () => {
  seed('taxonomy_types', {
    id: 't1', category: 'item_category', label: 'PPE', sort_order: 1, active: 1,
    updated_at: '2026-01-01T00:00:00Z',
  });
  await renderScreen(<InventoryScreen />);
  expect(screen.getByText('All')).toBeOnTheScreen();
  expect(screen.getByText('PPE')).toBeOnTheScreen();
});

test('hides edit affordances without edit_inventory', async () => {
  await renderScreen(<InventoryScreen />, { permissions: { edit_inventory: false } });
  expect(screen.queryByText('+ Add Item to Catalog')).not.toBeOnTheScreen();
  expect(screen.queryByLabelText('Select multiple items')).not.toBeOnTheScreen();
});

test('shows the multi-select affordance with edit_inventory', async () => {
  await renderScreen(<InventoryScreen />);
  expect(screen.getByLabelText('Select multiple items')).toBeOnTheScreen();
});

test('expanding a card and tapping Edit / details navigates to the detail route', async () => {
  seedItem('i1', 'Safety Glasses');
  await renderScreen(<InventoryScreen />);

  // The card header consumes the tap (expand), so detail is reached via its action row.
  await fireEvent.press(screen.getByText('Safety Glasses'));
  await fireEvent.press(await screen.findByText('Edit / details'));
  expect(navCalls).toContainEqual({
    method: 'push',
    args: [{ pathname: '/(app)/inventory/[id]', params: { id: 'i1' } }],
  });
});
