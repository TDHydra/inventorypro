// Tests for the hint policy half (which copy, who sees it, has it been seen)
// and for the auto-dismiss timer that used to outlive the screen.
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { renderScreen } from '../../test/renderScreen';
import { initPageDb, getDb, rowsAs } from '../../test/pageTestDb';
import { TooltipHint } from './TooltipHint';

const TIER4 = 'Low-stock items appear in orange. Set min_qty_alert on each item to trigger alerts.';
const TIER1 = 'Tap any item to see how much is at each location. Tap "Check Out" to take it.';

function seenRows(key = 'hint_seen_inventory') {
  return rowsAs<{ key: string; value: string }>(
    getDb().executeSync('SELECT key, value FROM app_settings WHERE key = ?', [key]).rows,
  );
}

beforeEach(async () => {
  await initPageDb();
});

test('shows the copy for the signed-in role tier', async () => {
  await renderScreen(<TooltipHint screenKey="inventory" />);
  expect(screen.getByText(TIER4)).toBeOnTheScreen();
});

test('a crew role gets the tier-1 copy instead', async () => {
  await renderScreen(<TooltipHint screenKey="inventory" />, { role: 'construction_crew' });
  expect(screen.getByText(TIER1)).toBeOnTheScreen();
  expect(screen.queryByText(TIER4)).not.toBeOnTheScreen();
});

test('renders nothing once the hint has been seen', async () => {
  getDb().executeSync(
    "INSERT INTO app_settings (key, value) VALUES ('hint_seen_inventory', '1')",
  );
  await renderScreen(<TooltipHint screenKey="inventory" />);
  expect(screen.queryByText(TIER4)).not.toBeOnTheScreen();
});

test('renders nothing for a screen with no hint copy', async () => {
  await renderScreen(<TooltipHint screenKey="no-such-screen" />);
  expect(screen.queryByText(/./)).not.toBeOnTheScreen();
});

test('dismissing marks the hint seen and hides it', async () => {
  await renderScreen(<TooltipHint screenKey="inventory" />);
  await fireEvent.press(screen.getByLabelText('Dismiss hint'));

  expect(seenRows()).toEqual([{ key: 'hint_seen_inventory', value: '1' }]);
  await waitFor(() => expect(screen.queryByText(TIER4)).not.toBeOnTheScreen());
});

describe('the 6s auto-dismiss', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  test('marks the hint seen on its own', async () => {
    await renderScreen(<TooltipHint screenKey="inventory" />);
    expect(seenRows()).toEqual([]);

    jest.advanceTimersByTime(6000);
    expect(seenRows()).toEqual([{ key: 'hint_seen_inventory', value: '1' }]);
  });

  // The regression: the timer used to survive unmount, so navigating away inside
  // the window fired dismiss() on a dead component — a state update into the void
  // and, worse, a settings write marking a hint seen that the user never saw.
  test('does nothing after the screen unmounts', async () => {
    const view = await renderScreen(<TooltipHint screenKey="inventory" />);
    await view.unmount();

    jest.advanceTimersByTime(12000);
    expect(seenRows()).toEqual([]);
  });
});
