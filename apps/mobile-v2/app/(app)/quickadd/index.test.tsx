// Render tests for the Quick Add launcher (grid of actions + permission gate).
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { initPageDb } from '../../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../../test/mocks/expoRouter';
import QuickAddLauncher from './index';

beforeEach(async () => { await initPageDb(); });

test('renders the launcher heading and header title for an admin', async () => {
  await renderScreen(<QuickAddLauncher />);
  expect(screen.getByText('What do you want to add?')).toBeOnTheScreen();
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Quick Add', headerShown: true }),
  );
});

test('shows every quick-add action tile', async () => {
  await renderScreen(<QuickAddLauncher />);
  for (const label of [
    'Item', 'Import CSV', 'Stock', 'Equipment', 'Location', 'Vehicle',
    'Gas Receipt', 'Job', 'Repair', 'Team', 'User',
  ]) {
    expect(screen.getByText(label)).toBeOnTheScreen();
  }
  expect(screen.getByText('Log a fuel-up')).toBeOnTheScreen();
});

test.each([
  ['Item', 'item'],
  ['Import CSV', 'csv-import'],
  ['Stock', 'stock'],
  ['Equipment', 'equipment'],
  ['Location', 'location'],
  ['Vehicle', 'vehicle'],
  ['Gas Receipt', 'gas-receipt'],
  ['Job', 'job'],
  ['Repair', 'repair'],
  ['Team', 'team'],
  ['User', 'user'],
])('tapping the %s tile pushes the %s quick-add sheet', async (label, kind) => {
  await renderScreen(<QuickAddLauncher />);
  await fireEvent.press(screen.getByText(label));
  expect(navCalls).toContainEqual({ method: 'push', args: [`/(app)/quickadd/${kind}`] });
});

test('is gated behind quick_add: shows Not authorized and no tiles', async () => {
  await renderScreen(<QuickAddLauncher />, { permissions: { quick_add: false } });

  expect(screen.getByText('Not authorized')).toBeOnTheScreen();
  expect(screen.queryByText('What do you want to add?')).not.toBeOnTheScreen();
  expect(screen.queryByText('Gas Receipt')).not.toBeOnTheScreen();
  // The gate keeps the same header title.
  expect(stackScreenOptions).toContainEqual(expect.objectContaining({ title: 'Quick Add' }));
});

test('the Not authorized screen can go back', async () => {
  await renderScreen(<QuickAddLauncher />, { permissions: { quick_add: false } });
  await fireEvent.press(screen.getByText('Go back'));
  expect(navCalls).toContainEqual({ method: 'back', args: [] });
});
