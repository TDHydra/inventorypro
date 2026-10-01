// Render tests for the Low Stock list screen.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { stackScreenOptions } from '../../../test/mocks/expoRouter';
import LowStockScreen from './low-stock';

function seedItem(id: string, name: string, extra: Record<string, unknown> = {}) {
  seed('inventory_items', {
    id, name, unit_category: 'count', unit: 'piece', kind: 'product', active: 1,
    min_qty_alert: 5, updated_at: '2026-01-01T00:00:00Z', ...extra,
  });
}
function seedStock(itemId: string, qty: number) {
  seed('stock_by_location', {
    item_id: itemId, location_id: 'loc-1', quantity: qty, updated_at: '2026-01-01T00:00:00Z',
  });
}

beforeEach(async () => { await initPageDb(); });

test('renders the empty state when nothing is low', async () => {
  await renderScreen(<LowStockScreen />);
  expect(screen.getByText('Nothing is low on stock right now.')).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<LowStockScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Low Stock', headerShown: true }),
  );
});

test('lists only items at or below their alert level', async () => {
  seedItem('i1', 'Nitrile Gloves'); seedStock('i1', 2);
  seedItem('i2', 'Plenty Of These'); seedStock('i2', 50);
  seedItem('i3', 'No Alert Set', { min_qty_alert: 0 }); seedStock('i3', 0);
  seedItem('i4', 'Retired Item', { active: 0 }); seedStock('i4', 0);
  await renderScreen(<LowStockScreen />);

  expect(screen.getByText('Nitrile Gloves')).toBeOnTheScreen();
  expect(screen.queryByText('Plenty Of These')).not.toBeOnTheScreen();
  expect(screen.queryByText('No Alert Set')).not.toBeOnTheScreen();
  expect(screen.queryByText('Retired Item')).not.toBeOnTheScreen();
  expect(screen.queryByText('Nothing is low on stock right now.')).not.toBeOnTheScreen();
});

test('an item with no stock rows at all counts as low', async () => {
  seedItem('i1', 'Zero Stock Item');
  await renderScreen(<LowStockScreen />);
  expect(screen.getByText('Zero Stock Item')).toBeOnTheScreen();
});

test('expanding a card offers a Check Out action', async () => {
  seedItem('i1', 'Nitrile Gloves'); seedStock('i1', 2);
  await renderScreen(<LowStockScreen />);
  await fireEvent.press(screen.getByText('Nitrile Gloves'));
  expect(await screen.findByText('Check Out')).toBeOnTheScreen();
});
