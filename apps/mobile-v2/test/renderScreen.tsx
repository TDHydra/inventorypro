// The one wrapper every page test renders through. A v2 screen is never mounted
// bare in the app: app/_layout.tsx puts SafeAreaProvider → KeyboardProvider →
// SessionContext.Provider above it, and useSession()/usePermission() read that
// context. Rendering a screen without them either crashes on a missing provider
// or silently resolves every permission to false, which makes a test assert the
// WRONG empty state. Keep this in sync with app/_layout.tsx's provider stack.
import type { ReactElement } from 'react';
import { render } from '@testing-library/react-native';
import { SafeAreaProvider, type Metrics } from 'react-native-safe-area-context';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SessionContext, type SessionContextValue } from '../src/hooks/useSession';
import type { UserSession } from '../src/auth/permissions';
import type { UserRole, Permission } from '../src/constants/roles';

// SafeAreaProvider measures its own insets on a real device and renders null
// until the first measurement lands, which would make every query fail. Passing
// initialMetrics skips the measure pass (the documented test setup) and is also
// what the #118/#163 insets bugs hinged on, so the values are non-zero on
// purpose — a screen that double-applies the bottom inset is visible here.
const TEST_METRICS: Metrics = {
  frame: { x: 0, y: 0, width: 390, height: 844 },
  insets: { top: 47, left: 0, right: 0, bottom: 34 },
};

export interface RenderScreenOptions {
  /** Signed-in role. Defaults to full_admin so a page under test renders its
   *  full UI unless the test is specifically about gating. */
  role?: UserRole;
  /** Per-permission overrides. These are the user-level override layer, which
   *  wins over role defaults, so `{ edit_inventory: false }` reliably hides
   *  edit affordances even for full_admin. */
  permissions?: Partial<Record<Permission, boolean>>;
  /** Replace the whole session user — pass null to render as signed out. */
  user?: UserSession | null;
  /** Role being previewed (#199), for tests of the preview banner/gating. */
  previewRole?: UserRole | null;
}

export function makeUser(options: RenderScreenOptions = {}): UserSession {
  return {
    id: 'user-1',
    name: 'Dev Tester',
    role: options.role ?? 'full_admin',
    permission_overrides: (options.permissions ?? {}) as Record<string, boolean>,
    pin_length_required: 4,
    active: 1,
    expires_at: null,
    team_contexts: [],
  };
}

export function makeSession(options: RenderScreenOptions = {}): SessionContextValue {
  const user = options.user === undefined ? makeUser(options) : options.user;
  return {
    user,
    realUser: user,
    setUser: jest.fn(),
    previewRole: options.previewRole ?? null,
    setPreviewRole: jest.fn(),
    logout: jest.fn(async () => {}),
  };
}

export function Providers({ children, ...options }: RenderScreenOptions & { children: ReactElement }) {
  return (
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
      <KeyboardProvider>
        <SessionContext.Provider value={makeSession(options)}>
          {children}
        </SessionContext.Provider>
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

/** Render a route component inside the app's real provider stack.
 *  RNTL v14 render is async — ALWAYS await this. */
export function renderScreen(ui: ReactElement, options: RenderScreenOptions = {}) {
  return render(<Providers {...options}>{ui}</Providers>);
}
