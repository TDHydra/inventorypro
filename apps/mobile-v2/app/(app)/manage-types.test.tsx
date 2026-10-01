// Render tests for the Manage Types (taxonomy admin) screen.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../test/renderScreen';
import { seed, initPageDb, getDb } from '../../test/pageTestDb';
import { stackScreenOptions } from '../../test/mocks/expoRouter';
import ManageTypesScreen from './manage-types';

const TS = '2026-01-01T00:00:00Z';

function seedType(id: string, category: string, label: string, extra: Record<string, unknown> = {}) {
  seed('taxonomy_types', { id, category, label, sort_order: 0, active: 1, updated_at: TS, ...extra });
}

beforeEach(async () => { await initPageDb(); });

test('renders every taxonomy section collapsed, as an index', async () => {
  await renderScreen(<ManageTypesScreen />);
  for (const title of [
    'Team Types', 'Job Types', 'Payers', 'Product Classes', 'Item Types',
    'Location Types', 'Location Sub-Types', 'Repair Statuses', 'Equipment Types',
  ]) {
    expect(screen.getByText(title)).toBeOnTheScreen();
  }
  expect(screen.queryByText('+ Add Item Type')).not.toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<ManageTypesScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Manage Types', headerShown: true }),
  );
});

test('expanding an empty section shows its empty state and add row', async () => {
  await renderScreen(<ManageTypesScreen />);
  await fireEvent.press(screen.getByText('Item Types'));
  expect(screen.getByText('No types yet. Add one below.')).toBeOnTheScreen();
  expect(screen.getByText('+ Add Item Type')).toBeOnTheScreen();
});

test('expanding a populated section lists its types and not other categories', async () => {
  seedType('t1', 'item_category', 'PPE');
  seedType('t2', 'item_category', 'Filters');
  seedType('t3', 'job_type_x', 'Elsewhere');
  seedType('t4', 'payer', 'Office');
  await renderScreen(<ManageTypesScreen />);
  await fireEvent.press(screen.getByText('Item Types'));
  expect(screen.getByText('PPE')).toBeOnTheScreen();
  expect(screen.getByText('Filters')).toBeOnTheScreen();
  expect(screen.queryByText('Office')).not.toBeOnTheScreen();
  expect(screen.queryByText('Elsewhere')).not.toBeOnTheScreen();
});

test('the section header counts active types and archived ones separately', async () => {
  seedType('t1', 'item_category', 'PPE');
  seedType('t2', 'item_category', 'Old Thing', { active: 0 });
  await renderScreen(<ManageTypesScreen />);
  expect(screen.getByText('1 +1 archived')).toBeOnTheScreen();
  await fireEvent.press(screen.getByText('Item Types'));
  expect(screen.getByText('archived')).toBeOnTheScreen();
});

test('Edit on a row opens the edit sheet for that type', async () => {
  seedType('t1', 'item_category', 'PPE');
  await renderScreen(<ManageTypesScreen />);
  await fireEvent.press(screen.getByText('Item Types'));
  await fireEvent.press(screen.getByText('Edit'));
  expect(await screen.findByText('Edit Type')).toBeOnTheScreen();
  expect(screen.getByText('No Changes')).toBeOnTheScreen();
});

test('+ Add opens the add sheet and rejects a blank label', async () => {
  await renderScreen(<ManageTypesScreen />);
  await fireEvent.press(screen.getByText('Item Types'));
  await fireEvent.press(screen.getByText('+ Add Item Type'));
  expect(await screen.findByPlaceholderText('Type label (e.g. Biohazard)')).toBeOnTheScreen();
  await fireEvent.press(screen.getByText('Add Type'));
  const rows = getDb().executeSync('SELECT COUNT(*) AS n FROM taxonomy_types WHERE category = ?', ['item_category']).rows;
  expect(Number((rows as any)[0]?.n ?? (rows as any)._array?.[0]?.n)).toBe(0);
});

test('shows the unauthorized notice without edit_inventory', async () => {
  seedType('t1', 'item_category', 'PPE');
  await renderScreen(<ManageTypesScreen />, { permissions: { edit_inventory: false } });
  expect(screen.getByText(/requires the "Edit catalog items" permission/)).toBeOnTheScreen();
  expect(screen.queryByText('Item Types')).not.toBeOnTheScreen();
});
