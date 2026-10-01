// Render tests for the entry redirect. It renders nothing; its job is to route
// to unlock (stored session) or login (none) via router.replace.
import { screen, waitFor } from '@testing-library/react-native';
import { renderScreen } from '../test/renderScreen';
import { seed, initPageDb } from '../test/pageTestDb';
import { navCalls } from '../test/mocks/expoRouter';
import Index from './index';

// In-memory SecureStore so a test can plant (or omit) a stored session.
const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => mockStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { mockStore.set(k, v); },
  deleteItemAsync: async (k: string) => { mockStore.delete(k); },
}));

function plantSession() {
  mockStore.set('inventorypro_refresh', 'r');
  mockStore.set('inventorypro_user_id', 'user-1');
}
function seedUser(active = 1) {
  seed('users', {
    id: 'user-1', name: 'Dev Tester', role: 'full_admin', pin_length_required: 4,
    active, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', pin_set: 1,
  });
}

beforeEach(async () => { mockStore.clear(); await initPageDb(); });

test('renders nothing visible (it is a pure redirect)', async () => {
  await renderScreen(<Index />, { user: null });
  expect(screen.queryByText(/./)).not.toBeOnTheScreen();
  await waitFor(() => expect(navCalls.length).toBeGreaterThan(0));
});

test('with no stored session it replaces to login', async () => {
  await renderScreen(<Index />, { user: null });
  await waitFor(() => expect(navCalls).toContainEqual({ method: 'replace', args: ['/(auth)/login'] }));
});

test('with a stored session for an active local user it replaces to unlock', async () => {
  plantSession();
  seedUser(1);
  await renderScreen(<Index />, { user: null });
  await waitFor(() => expect(navCalls).toContainEqual({ method: 'replace', args: ['/(auth)/unlock'] }));
});

test('a stored session whose user is deactivated falls back to login', async () => {
  plantSession();
  seedUser(0);
  await renderScreen(<Index />, { user: null });
  await waitFor(() => expect(navCalls).toContainEqual({ method: 'replace', args: ['/(auth)/login'] }));
  expect(navCalls).not.toContainEqual({ method: 'replace', args: ['/(auth)/unlock'] });
});

test('a stored user id without a refresh token is not a session', async () => {
  mockStore.set('inventorypro_user_id', 'user-1');
  seedUser(1);
  await renderScreen(<Index />, { user: null });
  await waitFor(() => expect(navCalls).toContainEqual({ method: 'replace', args: ['/(auth)/login'] }));
});
