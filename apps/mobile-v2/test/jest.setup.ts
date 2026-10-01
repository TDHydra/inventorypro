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

// A page render test must never perform network I/O. Several screens kick off
// syncNow() on mount or after a write (chat send, user edit, pull-to-refresh);
// the real engine then attempts an HTTP pull that fails asynchronously AFTER the
// test finished, which surfaces as "[Sync] Cycle error: Pull failed", "Cannot log
// after tests are done", and jest force-exiting the worker. Only the sync CYCLE
// is stubbed — everything else in @invenpro/core stays real, so repository
// writes, the outbox and the manifest all still behave normally and a test can
// still assert on rows the screen wrote.
//
// Exposed as a jest.fn(), so a test that cares can assert a screen requested a
// sync: expect(jest.mocked(syncNow)).toHaveBeenCalled() -- the barrel re-exports
// this module with `export *`, so the stub is what screens get.
//
// Mock the engine MODULE, never the '@invenpro/core' barrel: this file imports
// pageTestDb (and so the barrel) during setup, which instantiates and caches the
// barrel mock. A test file's own jest.mock('@invenpro/core', ...) would then be
// registered too late to ever be built, silently handing back the real
// implementation -- that is how the auth tests' local runFullDownload /
// fetchRoster stubs turned back into real functions.
jest.mock('../../../packages/core/src/sync/engine', () => ({
  ...jest.requireActual('../../../packages/core/src/sync/engine'),
  syncNow: jest.fn(async () => undefined),
}));

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
