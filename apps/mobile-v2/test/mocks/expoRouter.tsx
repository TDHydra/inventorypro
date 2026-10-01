// expo-router stand-in. The real router needs a mounted navigation container
// and a filesystem route tree; a page test renders ONE screen in isolation, so
// navigation is recorded instead of performed and asserted on afterwards.
import type { ReactNode } from 'react';
import { useEffect } from 'react';

export interface NavCall { method: string; args: unknown[] }

/** Every push/replace/back a rendered screen performs, in order. Cleared per
 *  test by the global beforeEach in test/jest.setup.ts. */
export const navCalls: NavCall[] = [];

let params: Record<string, string> = {};
let pathname = '/';

/** Set the route params a screen will read, e.g. for app/(app)/jobs/[id].tsx:
 *  setRouteParams({ id: 'job-1' }). */
export function setRouteParams(next: Record<string, string>): void { params = next; }
export function setPathname(next: string): void { pathname = next; }
export function resetRouter(): void {
  navCalls.length = 0;
  params = {};
  pathname = '/';
}

const record = (method: string) => (...args: unknown[]) => { navCalls.push({ method, args }); };

export const router = {
  push: record('push'),
  replace: record('replace'),
  back: record('back'),
  navigate: record('navigate'),
  dismiss: record('dismiss'),
  dismissAll: record('dismissAll'),
  setParams: record('setParams'),
  canGoBack: () => true,
};

export function useRouter() { return router; }
export function useLocalSearchParams<T = Record<string, string>>() { return params as T; }
export function useSearchParams() { return params; }
export function usePathname() { return pathname; }
export function useSegments() { return pathname.split('/').filter(Boolean); }

/** The real useFocusEffect fires on screen focus; an isolated render is always
 *  "focused", so run the effect once on mount. */
export function useFocusEffect(effect: () => void | (() => void)) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(effect, []);
}

/** <Stack.Screen options={...} /> only configures the native header, which has
 *  no body to render here — swallow it but keep the options inspectable. */
export const stackScreenOptions: Record<string, unknown>[] = [];

function StackScreen(props: { options?: Record<string, unknown> }) {
  if (props.options) stackScreenOptions.push(props.options);
  return null;
}

export const Stack = Object.assign(
  ({ children }: { children?: ReactNode }) => <>{children}</>,
  { Screen: StackScreen },
);

export const Tabs = Object.assign(
  ({ children }: { children?: ReactNode }) => <>{children}</>,
  { Screen: StackScreen },
);

/** <Redirect href> unmounts the screen in the real router. Record it as a
 *  navigation so a test can assert "this screen redirects when unauthorized". */
export function Redirect({ href }: { href: unknown }) {
  navCalls.push({ method: 'redirect', args: [href] });
  return null;
}

export function Link({ children }: { href?: unknown; children?: ReactNode }) {
  return <>{children}</>;
}

export function SplashScreen() { return null; }
export const useNavigation = () => ({ setOptions: record('setOptions'), addListener: () => () => {} });
