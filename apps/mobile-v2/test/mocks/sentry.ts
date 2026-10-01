// @sentry/react-native — no-op so error paths under test don't try to reach the
// network or require native init. captureException is a jest.fn() so a test can
// assert a screen reported an error.
export const init = jest.fn();
export const captureException = jest.fn();
export const captureMessage = jest.fn();
export const addBreadcrumb = jest.fn();
export const setUser = jest.fn();
export const setTag = jest.fn();
export const setContext = jest.fn();
export const wrap = <T,>(component: T): T => component;
export const withScope = (fn: (scope: unknown) => void) => fn({ setTag: jest.fn(), setContext: jest.fn() });
export const reactNavigationIntegration = () => ({ name: 'ReactNavigation' });
export const nativeApplicationVersion = '2.0.0-test';
