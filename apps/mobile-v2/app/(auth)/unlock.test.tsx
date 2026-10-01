// Render tests for the biometric unlock screen (signed out).
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { renderScreen } from '../../test/renderScreen';
import { seed, initPageDb } from '../../test/pageTestDb';
import { navCalls, setRouteParams } from '../../test/mocks/expoRouter';
import { promptBiometric } from '../../src/auth/biometric';
import UnlockScreen from './unlock';

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: async (k: string) => mockStore.get(k) ?? null,
  setItemAsync: async (k: string, v: string) => { mockStore.set(k, v); },
  deleteItemAsync: async (k: string) => { mockStore.delete(k); },
}));
jest.mock('../../src/auth/biometric', () => ({
  promptBiometric: jest.fn(),
  isBiometricAvailable: jest.fn(async () => true),
}));
const mockPrompt = promptBiometric as jest.Mock;

beforeEach(async () => {
  mockStore.clear();
  mockPrompt.mockReset();
  await initPageDb();
  mockStore.set('inventorypro_user_id', 'user-1');
  seed('users', {
    id: 'user-1', name: 'Dev Tester', role: 'full_admin', pin_length_required: 4,
    active: 1, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', pin_set: 1,
  });
});

test('shows the unlocking state while the biometric prompt is pending', async () => {
  mockPrompt.mockReturnValue(new Promise(() => {}));
  await renderScreen(<UnlockScreen />, { user: null });
  expect(screen.getByText('InventoryPro')).toBeOnTheScreen();
  await waitFor(() => expect(screen.getByText('Unlocking for Dev Tester…')).toBeOnTheScreen());
});

test('a passing biometric enters the app', async () => {
  mockPrompt.mockResolvedValue(true);
  await renderScreen(<UnlockScreen />, { user: null });
  await waitFor(() => expect(navCalls).toContainEqual({ method: 'replace', args: ['/(app)'] }));
  expect(mockPrompt).toHaveBeenCalledWith('Unlock as Dev Tester');
});

test('a same-app deep-link target is honoured after unlock', async () => {
  mockPrompt.mockResolvedValue(true);
  setRouteParams({ next: '/(app)/jobs' });
  await renderScreen(<UnlockScreen />, { user: null });
  await waitFor(() => expect(navCalls).toContainEqual({ method: 'replace', args: ['/(app)/jobs'] }));
});

test('a protocol-relative next target is rejected in favour of the dashboard', async () => {
  mockPrompt.mockResolvedValue(true);
  setRouteParams({ next: '//evil.example' });
  await renderScreen(<UnlockScreen />, { user: null });
  await waitFor(() => expect(navCalls).toContainEqual({ method: 'replace', args: ['/(app)'] }));
});

test('a canceled biometric shows the locked state with retry and switch-user', async () => {
  mockPrompt.mockResolvedValue(false);
  await renderScreen(<UnlockScreen />, { user: null });
  await waitFor(() => expect(screen.getByText('Unlock canceled')).toBeOnTheScreen());
  expect(screen.getByText('Unlock')).toBeOnTheScreen();
  expect(screen.getByText('Sign in as someone else')).toBeOnTheScreen();
  expect(navCalls).toEqual([]);
});

test('"Sign in as someone else" clears the session and goes to login', async () => {
  mockPrompt.mockResolvedValue(false);
  await renderScreen(<UnlockScreen />, { user: null });
  await waitFor(() => expect(screen.getByText('Sign in as someone else')).toBeOnTheScreen());
  await fireEvent.press(screen.getByText('Sign in as someone else'));
  await waitFor(() => expect(navCalls).toContainEqual({ method: 'replace', args: ['/(auth)/login'] }));
  expect(mockStore.has('inventorypro_user_id')).toBe(false);
});

test('no saved user id redirects straight to login', async () => {
  mockStore.clear();
  await renderScreen(<UnlockScreen />, { user: null });
  await waitFor(() => expect(navCalls).toContainEqual({ method: 'replace', args: ['/(auth)/login'] }));
  expect(mockPrompt).not.toHaveBeenCalled();
});
