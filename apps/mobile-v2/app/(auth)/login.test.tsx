// Render tests for the sign-in screen (signed out): roster picker, PIN pad,
// and the first-login enrollment wizard.
import { screen, fireEvent, waitFor } from '@testing-library/react-native';
import { renderScreen } from '../../test/renderScreen';
import { seed, initPageDb } from '../../test/pageTestDb';
import { navCalls } from '../../test/mocks/expoRouter';
import { fetchRoster } from '@invenpro/core';
import LoginScreen from './login';

jest.mock('expo-secure-store', () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
jest.mock('@invenpro/core', () => ({
  ...jest.requireActual('@invenpro/core'),
  fetchRoster: jest.fn(),
}));
const mockFetchRoster = fetchRoster as jest.Mock;

function seedUser(id: string, name: string, extra: Record<string, unknown> = {}) {
  seed('users', {
    id, name, role: 'full_admin', pin_length_required: 4, active: 1, pin_set: 1,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...extra,
  });
}

beforeEach(async () => {
  mockFetchRoster.mockReset();
  await initPageDb();
});

test('lists the local roster on a returning device without hitting the network', async () => {
  seedUser('u1', 'Alice Admin');
  seedUser('u2', 'Bob Builder', { role: 'construction_crew' });
  await renderScreen(<LoginScreen />, { user: null });

  expect(screen.getByText('Who are you?')).toBeOnTheScreen();
  expect(screen.getByText('Alice Admin')).toBeOnTheScreen();
  expect(screen.getByText('Bob Builder')).toBeOnTheScreen();
  expect(screen.getByText('construction crew')).toBeOnTheScreen();
  expect(mockFetchRoster).not.toHaveBeenCalled();
});

test('hides inactive, demo/test and expired users from the picker', async () => {
  seedUser('u1', 'Alice Admin');
  seedUser('u2', 'Gone Gary', { active: 0 });
  seedUser('u3', 'Demo Dana', { is_test: 1 });
  seedUser('u4', 'Expired Ed', { expires_at: '2020-01-01T00:00:00Z' });
  await renderScreen(<LoginScreen />, { user: null });

  expect(screen.getByText('Alice Admin')).toBeOnTheScreen();
  expect(screen.queryByText('Gone Gary')).not.toBeOnTheScreen();
  expect(screen.queryByText('Demo Dana')).not.toBeOnTheScreen();
  expect(screen.queryByText('Expired Ed')).not.toBeOnTheScreen();
});

test('an empty local DB fetches the public roster (new device)', async () => {
  mockFetchRoster.mockResolvedValue({
    users: [{ id: 'r1', name: 'Remote Rita', role: 'office_manager', pin_length_required: 4, pin_set: 1 }],
    default_theme_id: null,
  });
  await renderScreen(<LoginScreen />, { user: null });
  await waitFor(() => expect(screen.getByText('Remote Rita')).toBeOnTheScreen());
  expect(mockFetchRoster).toHaveBeenCalledTimes(1);
});

test('a roster fetch failure shows the error and a retry', async () => {
  mockFetchRoster.mockRejectedValueOnce(new Error('Could not reach the server.'));
  await renderScreen(<LoginScreen />, { user: null });
  await waitFor(() => expect(screen.getByText('Could not reach the server.')).toBeOnTheScreen());

  mockFetchRoster.mockResolvedValueOnce({
    users: [{ id: 'r1', name: 'Remote Rita', role: 'office_manager', pin_length_required: 4, pin_set: 1 }],
    default_theme_id: null,
  });
  await fireEvent.press(screen.getByText('Tap to retry'));
  await waitFor(() => expect(screen.getByText('Remote Rita')).toBeOnTheScreen());
});

test('an empty roster that fetches no users shows the contact-admin message', async () => {
  mockFetchRoster.mockResolvedValue({ users: [], default_theme_id: null });
  await renderScreen(<LoginScreen />, { user: null });
  await waitFor(() => expect(screen.getByText('No users found. Contact your admin.')).toBeOnTheScreen());
});

test('the search box filters the roster by name', async () => {
  seedUser('u1', 'Alice Admin');
  seedUser('u2', 'Bob Builder');
  await renderScreen(<LoginScreen />, { user: null });

  await fireEvent.changeText(screen.getByPlaceholderText('Search name...'), 'bob');
  expect(screen.getByText('Bob Builder')).toBeOnTheScreen();
  expect(screen.queryByText('Alice Admin')).not.toBeOnTheScreen();
});

test('picking a user with a PIN set opens the PIN pad, and Back returns to the picker', async () => {
  seedUser('u1', 'Alice Admin');
  await renderScreen(<LoginScreen />, { user: null });

  await fireEvent.press(screen.getByText('Alice Admin'));
  expect(screen.getByText('Enter your PIN')).toBeOnTheScreen();
  expect(screen.getByText('4-digit PIN')).toBeOnTheScreen();
  expect(screen.queryByText('Who are you?')).not.toBeOnTheScreen();

  await fireEvent.press(screen.getByText('← Back'));
  expect(screen.getByText('Who are you?')).toBeOnTheScreen();
});

test('picking a user without a PIN starts the enrollment-code step', async () => {
  seedUser('u1', 'New Nora', { pin_set: 0 });
  await renderScreen(<LoginScreen />, { user: null });

  await fireEvent.press(screen.getByText('New Nora'));
  expect(screen.getByText('👋 First sign-in — enter your code')).toBeOnTheScreen();
  expect(screen.getByText('Enrollment code')).toBeOnTheScreen();

  // Continue is inert until all 6 digits are in; then it advances to PIN creation.
  await fireEvent.changeText(screen.getByPlaceholderText('000000'), '123456');
  await fireEvent.press(screen.getByText('Continue'));
  expect(screen.getByText('Create your PIN')).toBeOnTheScreen();
});

test('a first-login user is held to the role minimum PIN length', async () => {
  seedUser('u1', 'New Nora', { pin_set: 0, pin_length_required: 4 });
  seed('role_settings', { role: 'full_admin', min_pin_length: 6, updated_at: '2026-01-01T00:00:00Z' });
  await renderScreen(<LoginScreen />, { user: null });

  await fireEvent.press(screen.getByText('New Nora'));
  await fireEvent.changeText(screen.getByPlaceholderText('000000'), '123456');
  await fireEvent.press(screen.getByText('Continue'));
  expect(screen.getByText("Choose a 6-digit PIN you'll use to sign in.")).toBeOnTheScreen();
});

test('does not navigate anywhere until a sign-in succeeds', async () => {
  seedUser('u1', 'Alice Admin');
  await renderScreen(<LoginScreen />, { user: null });
  await fireEvent.press(screen.getByText('Alice Admin'));
  expect(navCalls).toEqual([]);
});
