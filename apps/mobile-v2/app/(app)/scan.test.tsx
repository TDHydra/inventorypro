// Render tests for the hub Scan screen. The camera path is a native module, so
// these cover the shell: mode toggle, USB mode, header, cancel.
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../test/renderScreen';
import { initPageDb } from '../../test/pageTestDb';
import { navCalls, stackScreenOptions } from '../../test/mocks/expoRouter';
import ScanScreen from './scan';


beforeEach(async () => { await initPageDb(); });

test('renders with both scan-mode buttons', async () => {
  await renderScreen(<ScanScreen />);
  expect(screen.getByText('📷 Camera')).toBeOnTheScreen();
  expect(screen.getByText(/USB Scanner/)).toBeOnTheScreen();
});

test('sets the native header title', async () => {
  await renderScreen(<ScanScreen />);
  expect(stackScreenOptions).toContainEqual(
    expect.objectContaining({ title: 'Scan Barcode', headerShown: true }),
  );
});

test('starts in camera mode, not USB mode', async () => {
  await renderScreen(<ScanScreen />);
  expect(screen.queryByText('USB Scanner Ready')).not.toBeOnTheScreen();
});

test('switching to USB mode shows the USB-ready panel', async () => {
  await renderScreen(<ScanScreen />);
  await fireEvent.press(screen.getByText(/USB Scanner/));
  expect(screen.getByText('USB Scanner Ready')).toBeOnTheScreen();
});

test('Cancel in USB mode goes back', async () => {
  await renderScreen(<ScanScreen />);
  await fireEvent.press(screen.getByText(/USB Scanner/));
  await fireEvent.press(screen.getByText('Cancel'));
  expect(navCalls).toContainEqual({ method: 'back', args: [] });
});
