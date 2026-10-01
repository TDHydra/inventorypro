# Batch: auth & entry

| Page | Test file | Tests |
|---|---|---|
| `app/index.tsx` | `app/index.test.tsx` | 5 |
| `app/(auth)/login.tsx` | `app/(auth)/login.test.tsx` | 10 |
| `app/(auth)/unlock.tsx` | `app/(auth)/unlock.test.tsx` | 7 |
| `app/(auth)/first-launch.tsx` | `app/(auth)/first-launch.test.tsx` | 7 |
| `app/(app)/index.tsx` | `app/(app)/index.test.tsx` | 11 |

Total 40, all passing. No skips.

## Shortcuts taken
- `expo-secure-store` is mocked locally (in-memory Map) in index/unlock/first-launch/login tests; the real `session.ts` runs against it.
- `src/auth/biometric` mocked locally in unlock (controls the prompt result).
- `@invenpro/core` partially mocked (`runFullDownload` in first-launch, `fetchRoster` in login); everything else is real.
- Login: PIN submit / server verification (`verifyPinOnline`, `setPinFirstTime`) is NOT exercised; tests stop at PIN pad / enrollment-step render. PINPad key entry not driven.
- Dashboard: StatTiles/WorkList/QuickActionsRow render against an empty DB; only stat tile labels asserted, not counts or work-list rows.
- Mock variables must be named `mock*` (babel-plugin-jest-hoist) when referenced in a `jest.mock` factory.

## Harness gaps found
- None blocking. Note: `renderScreen(<Index />)` always has provider output, so "renders nothing" is asserted via `queryByText(/./)`, not `toJSON()`.
- Observation: a shared in-memory `expo-secure-store` mock in `test/mocks` would remove the duplicated 5-line mock from 4 files.
- jest path patterns are regexes: `"app/(auth)"` matches nothing; use `"app/.auth./"`.
- Dashboard finding: `full_admin` keeps `manage_roles_permissions` even with an override of false (FULL_ADMIN_FLOOR), asserted in a test.
