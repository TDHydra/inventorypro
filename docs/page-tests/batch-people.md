# Page tests: People, Teams & Roles batch

Run: `cd apps/mobile-v2 && npx jest "app/(app)/users" "app/(app)/teams" "app/(app)/roles" "app/(app)/myteam" "app/(app)/notifications"`
Result: 6 suites passed, 68 tests passed. `tsc --noEmit` reports nothing for these files.

| Page | Tests |
|---|---|
| `app/(app)/users/index.tsx` | 19 |
| `app/(app)/teams/index.tsx` | 9 |
| `app/(app)/teams/[id].tsx` | 13 |
| `app/(app)/roles/index.tsx` | 10 |
| `app/(app)/myteam.tsx` | 9 |
| `app/(app)/notifications/index.tsx` | 8 |

## Shortcuts taken
- No write-path tests that go through `confirmSheet` (roles permission toggles, min-PIN stepper, bulk actions, remove member, make manager). Only the gating and render side is covered, not the confirm-then-commit flow.
- users: create/save/reset-PIN network calls (`createUserOnline`, `resetUserPinOnline`) are not exercised; bulk pickers are only reached as far as the action bar.
- roles: gating is asserted through the lock/reason text (tier guard, full-admin-only delete grants), not by pressing disabled switches.
- myteam: CrewEditor, the locker access sheet and VehicleSheet are not opened.
- teams/[id]: add-member, edit-team, crew editor and member-permission sheets are not opened.
- teams/[id] and users DM tests only check that `/(app)/chat/[id]` is pushed; `syncNow` fails offline and logs a harmless `[Sync] Cycle error` warning.

## Harness gaps found
- None blocking; no local `jest.mock()` was needed.
- The jest run prints "A worker process has failed to exit gracefully" after the suites pass. Likely a timer leak in shared code or the harness; not investigated.
