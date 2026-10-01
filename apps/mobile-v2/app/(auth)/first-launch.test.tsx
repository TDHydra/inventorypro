// Render tests for the post-login enrollment download screen (signed out).
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { renderScreen } from '../../test/renderScreen';
import { seed, initPageDb } from '../../test/pageTestDb';
import { navCalls } from '../../test/mocks/expoRouter';
import { runFullDownload } from '@invenpro/core';
import FirstLaunchScreen from './first-launch';

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => mockStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { mockStore.set(k, v); },
  deleteItemAsync: async (k: string) => { mockStore.delete(k); },
}));
jest.mock('@invenpro/core', () => ({
  ...jest.requireActual('@invenpro/core'),
  runFullDownload: jest.fn(),
}));
const mockDownload = runFullDownload as jest.Mock;

// A JWT with no exp: getValidJwt hands it back untouched (no network refresh).
const JWT = 'a.' + Buffer.from('{}').toString('base64') + '.c';

beforeEach(async () => {
  mockStore.clear();
  mockDownload.mockReset();
  await initPageDb();
  mockStore.set('inventorypro_jwt', JWT);
  mockStore.set('inventorypro_user_id', 'user-1');
});

function seedUser() {
  seed('users', {
    id: 'user-1', name: 'Dev Tester', role: 'full_admin', pin_length_required: 4,
    active: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', pin_set: 1,
  });
}

test('renders the setup progress UI while the download runs', async () => {
  mockDownload.mockReturnValue(new Promise(() => {}));
  seedUser();
  await renderScreen(<FirstLaunchScreen />, { user: null });
  expect(screen.getByText('Setting things up...')).toBeOnTheScreen();
  expect(screen.getByText('0%')).toBeOnTheScreen();
  expect(screen.getByText('💡 One-time setup')).toBeOnTheScreen();
});

test('reflects progress reported by the download', async () => {
  mockDownload.mockImplementation(async (_jwt: string, onProgress: (p: unknown) => void) => {
    onProgress({ table: 'users', step: 1, total: 4 });
    return new Promise(() => {});
  });
  seedUser();
  await renderScreen(<FirstLaunchScreen />, { user: null });
  await waitFor(() => expect(screen.getByText('25%')).toBeOnTheScreen());
  expect(screen.getByText(/Downloading team members/)).toBeOnTheScreen();
});

test('passes the stored JWT to the download', async () => {
  mockDownload.mockReturnValue(new Promise(() => {}));
  seedUser();
  await renderScreen(<FirstLaunchScreen />, { user: null });
  await waitFor(() => expect(mockDownload).toHaveBeenCalled());
  expect(mockDownload.mock.calls[0][0]).toBe(JWT);
});

test('a finished download enters the app', async () => {
  mockDownload.mockResolvedValue(undefined);
  seedUser();
  await renderScreen(<FirstLaunchScreen />, { user: null });
  await waitFor(() => expect(navCalls).toContainEqual({ method: 'replace', args: ['/(app)'] }));
});

test('a failed download shows the error and retries on tap', async () => {
  mockDownload.mockRejectedValueOnce(new Error('network down'));
  seedUser();
  await renderScreen(<FirstLaunchScreen />, { user: null });
  await waitFor(() => expect(screen.getByText('Setup failed')).toBeOnTheScreen());
  expect(screen.getByText('network down')).toBeOnTheScreen();

  mockDownload.mockResolvedValueOnce(undefined);
  await fireEvent.press(screen.getByText('Tap to retry'));
  await waitFor(() => expect(navCalls).toContainEqual({ method: 'replace', args: ['/(app)'] }));
});

test('a finished download for an unknown user asks to sign in again', async () => {
  mockDownload.mockResolvedValue(undefined);
  // no user row seeded
  await renderScreen(<FirstLaunchScreen />, { user: null });
  await waitFor(() => expect(screen.getByText('Setup failed')).toBeOnTheScreen());
  expect(screen.getByText(/account was not found/)).toBeOnTheScreen();
});

test('no saved session sends the user back to login', async () => {
  mockStore.clear();
  await renderScreen(<FirstLaunchScreen />, { user: null });
  await waitFor(() => expect(navCalls).toContainEqual({ method: 'replace', args: ['/(auth)/login'] }));
  expect(mockDownload).not.toHaveBeenCalled();
});
