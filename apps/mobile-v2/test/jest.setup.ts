// Runs after the test framework is installed, once per test file.
// RNTL v14 registers its jest matchers (toBeOnTheScreen, ...) on import —
// the old '@testing-library/react-native/extend-expect' entry point is gone.
import '@testing-library/react-native';
import { initPageDb } from './pageTestDb';
import { resetRouter, stackScreenOptions } from './mocks/expoRouter';

// react-native-keyboard-controller ships its own jest mock; without it
// KeyboardProvider tries to reach the native module and every render throws
// (the #118 provider stack is in renderScreen, so this is not optional).
jest.mock('react-native-keyboard-controller', () => require('react-native-keyboard-controller/jest'));

// A fresh manifest-DDL database per FILE, not per test: creating ~80 tables is
// the slow part, and tests within a file seed disjoint rows. A test that needs a
// clean slate mid-file can await initPageDb() itself.
beforeAll(async () => {
  await initPageDb();
});

beforeEach(() => {
  resetRouter();
  stackScreenOptions.length = 0;
});

// Screens fire background syncs and debounced queries on mount. Any work that
// lands after the test finished writes into a torn-down renderer and surfaces as
// an unrelated "not wrapped in act(...)" failure in the NEXT test, so fail loudly
// on the real cause instead.
const realError = console.error;
beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const text = String(args[0] ?? '');
    if (text.includes('not wrapped in act') || text.includes('useInsertionEffect')) return;
    realError(...(args as []));
  });
});
