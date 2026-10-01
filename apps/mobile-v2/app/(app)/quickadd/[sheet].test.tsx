// Render tests for the dynamic Quick Add route: the `sheet` param selects WHICH
// add form renders. The supported list is KIND_TITLES in [sheet].tsx.
import { screen } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { initPageDb } from '../../../test/pageTestDb';
import { navCalls, setRouteParams, stackScreenOptions } from '../../../test/mocks/expoRouter';
import QuickAddSheetScreen from './[sheet]';

beforeEach(async () => { await initPageDb(); });

// One entry per sheet value the route supports.
const SHEETS: [string, string][] = [
  ['item', 'Quick Add — Item'],
  ['location', 'Quick Add — Location'],
  ['stock', 'Quick Add — Stock'],
  ['equipment', 'Quick Add — Equipment'],
  ['csv-import', 'Quick Add — Import CSV'],
  ['user', 'Quick Add — User'],
  ['team', 'Quick Add — Team'],
  ['vehicle', 'Quick Add — Vehicle'],
  ['gas-receipt', 'Quick Add — Gas Receipt'],
  ['job', 'Quick Add — Job'],
  ['repair', 'Quick Add — Repair'],
];

test.each(SHEETS)('sheet=%s renders its form under the header "%s"', async (sheet, title) => {
  setRouteParams({ sheet });
  await renderScreen(<QuickAddSheetScreen />);

  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title, headerShown: true }));
  // It rendered a form, not a redirect.
  expect(navCalls.filter(c => c.method === 'redirect')).toHaveLength(0);
});

test('an unknown sheet redirects to the chooser', async () => {
  setRouteParams({ sheet: 'nonsense' });
  await renderScreen(<QuickAddSheetScreen />);
  expect(navCalls).toContainEqual({ method: 'redirect', args: ['/(app)/quickadd'] });
});

test('a missing sheet param redirects to the chooser', async () => {
  setRouteParams({});
  await renderScreen(<QuickAddSheetScreen />);
  expect(navCalls).toContainEqual({ method: 'redirect', args: ['/(app)/quickadd'] });
});

test('different sheet values render different forms (location vs vehicle)', async () => {
  setRouteParams({ sheet: 'location' });
  const first = await renderScreen(<QuickAddSheetScreen />);
  expect(screen.getByPlaceholderText('Enter location name')).toBeOnTheScreen();
  expect(screen.queryByPlaceholderText('Vehicle name *')).not.toBeOnTheScreen();
  await first.unmount();

  setRouteParams({ sheet: 'vehicle' });
  await renderScreen(<QuickAddSheetScreen />);
  expect(screen.getByPlaceholderText('Vehicle name *')).toBeOnTheScreen();
  expect(screen.queryByPlaceholderText('Enter location name')).not.toBeOnTheScreen();
});

test('the quick_add gate blocks a deep-linked sheet', async () => {
  setRouteParams({ sheet: 'location' });
  await renderScreen(<QuickAddSheetScreen />, { permissions: { quick_add: false } });

  expect(screen.getByText('Not authorized')).toBeOnTheScreen();
  expect(screen.queryByPlaceholderText('Enter location name')).not.toBeOnTheScreen();
});

test('the team form renders its fields', async () => {
  setRouteParams({ sheet: 'team' });
  await renderScreen(<QuickAddSheetScreen />);
  expect(screen.getByPlaceholderText('Team name *')).toBeOnTheScreen();
});

test('the job form renders its fields', async () => {
  setRouteParams({ sheet: 'job' });
  await renderScreen(<QuickAddSheetScreen />);
  expect(screen.getByPlaceholderText('Enter job name')).toBeOnTheScreen();
  expect(screen.getByText('Customer Name')).toBeOnTheScreen();
});
