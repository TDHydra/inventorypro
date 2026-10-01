// Render tests for the Check Out / Check In wizard. Covers the 'find' home step,
// the item -> qty step transition, the check-in panel, and permission gating.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../test/renderScreen';
import { seed, initPageDb } from '../../test/pageTestDb';
import { navCalls, setRouteParams, stackScreenOptions } from '../../test/mocks/expoRouter';
import CheckoutScreen from './checkout';


const TS = '2026-01-01T00:00:00Z';

function seedItem(id: string, name: string, extra: Record<string, unknown> = {}) {
  seed('inventory_items', {
    id, name, unit_category: 'count', unit: 'piece', kind: 'product', active: 1,
    updated_at: TS, ...extra,
  });
}
function seedStock(itemId: string, locId: string, locName: string, qty: number) {
  seed('locations', { id: locId, name: locName, type: 'Warehouse', active: 1, updated_at: TS });
  seed('stock_by_location', { item_id: itemId, location_id: locId, quantity: qty, updated_at: TS });
}

beforeEach(async () => { await initPageDb(); });

test('renders the find step with search box, mode toggle and header', async () => {
  await renderScreen(<CheckoutScreen />);
  expect(screen.getByPlaceholderText('Search item name or barcode...')).toBeOnTheScreen();
  expect(screen.getByText('Type to search inventory')).toBeOnTheScreen();
  expect(screen.getByText('Check Out')).toBeOnTheScreen();
  expect(screen.getByText('Check In')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Check Out Item', headerShown: true }),
  );
});

test('searching with no match shows "No items found"', async () => {
  await renderScreen(<CheckoutScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('Search item name or barcode...'), 'zzz');
  expect(screen.getByText('No items found')).toBeOnTheScreen();
});

test('searching lists matching items only', async () => {
  seedItem('i1', 'Safety Glasses');
  seedItem('i2', 'Work Gloves');
  await renderScreen(<CheckoutScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('Search item name or barcode...'), 'Glass');
  expect(screen.getByText('Safety Glasses')).toBeOnTheScreen();
  expect(screen.queryByText('Work Gloves')).not.toBeOnTheScreen();
});

test('picking an item advances to the qty step with its stock sources', async () => {
  seedItem('i1', 'Safety Glasses');
  seedStock('i1', 'l1', 'Main Warehouse', 12);
  await renderScreen(<CheckoutScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('Search item name or barcode...'), 'Glass');
  await fireEvent.press(screen.getByText('Safety Glasses'));

  expect(await screen.findByText('Source Location')).toBeOnTheScreen();
  expect(screen.getByText('Main Warehouse')).toBeOnTheScreen();
  expect(screen.getByText('Next: Choose Destination →')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Select Location & Qty' }),
  );
});

test('an item with no stock shows the "No stock available" source state', async () => {
  seedItem('i1', 'Safety Glasses');
  await renderScreen(<CheckoutScreen />);
  await fireEvent.changeText(screen.getByPlaceholderText('Search item name or barcode...'), 'Glass');
  await fireEvent.press(screen.getByText('Safety Glasses'));
  expect(await screen.findByText('No stock available')).toBeOnTheScreen();
});

test('arriving with an itemId param skips straight to the qty step', async () => {
  seedItem('i1', 'Safety Glasses');
  seedStock('i1', 'l1', 'Main Warehouse', 12);
  setRouteParams({ itemId: 'i1' });
  await renderScreen(<CheckoutScreen />);
  expect(await screen.findByText('Source Location')).toBeOnTheScreen();
  expect(screen.queryByPlaceholderText('Search item name or barcode...')).not.toBeOnTheScreen();
});

test('Scan Barcode Instead navigates to the scan route', async () => {
  await renderScreen(<CheckoutScreen />);
  await fireEvent.press(screen.getByText(/Scan Barcode Instead/));
  expect(navCalls).toContainEqual({ method: 'push', args: ['/(app)/scan'] });
});

test('Check In toggle shows the empty check-in panel', async () => {
  await renderScreen(<CheckoutScreen />);
  await fireEvent.press(screen.getByText('Check In'));
  expect(await screen.findByText('No Active Checkouts')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Check In Items' }),
  );
});

test('quick-source strip lists locations for an admin', async () => {
  seed('locations', { id: 'l1', name: 'Main Warehouse', type: 'Warehouse', active: 1, updated_at: TS });
  seed('locations', { id: 'l2', name: 'Back Yard', type: 'Warehouse', active: 1, updated_at: TS });
  await renderScreen(<CheckoutScreen />);
  expect(screen.getByText('Where are you working from?')).toBeOnTheScreen();
  expect(screen.getByText(/Main Warehouse/)).toBeOnTheScreen();
});

test('without checkout_inventory the quick-source locations are not offered', async () => {
  seed('locations', { id: 'l1', name: 'Main Warehouse', type: 'Warehouse', active: 1, updated_at: TS });
  seed('locations', { id: 'l2', name: 'Back Yard', type: 'Warehouse', active: 1, updated_at: TS });
  await renderScreen(<CheckoutScreen />, { permissions: { checkout_inventory: false } });
  expect(screen.queryByText('Where are you working from?')).not.toBeOnTheScreen();
  expect(screen.queryByText(/Main Warehouse/)).not.toBeOnTheScreen();
});
