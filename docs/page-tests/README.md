# Page render tests — coverage ledger

How to write one: `docs/PAGE-TESTS.md`. This file is the reconciled result of the
batch that created them (board #291).

**All 47 route pages under `apps/mobile-v2/app/` have a test file.** The four
non-page files are excluded: the three `_layout.tsx` provider shells and
`+html.tsx`.

| Batch | Pages | Tests | Ledger |
|---|---|---|---|
| inventory + scan/checkout/manage-types | 6 | 44 | [batch-inventory.md](batch-inventory.md) |
| jobs, schedule, approvals, oncall, logs | 6 | 39 | [batch-jobs.md](batch-jobs.md) |
| equipment, repairs, media | 5 | 38 | [batch-equipment.md](batch-equipment.md) |
| locations, lockers, vehicles/[id], access | 6 | 43 | [batch-locations.md](batch-locations.md) |
| users, teams, roles, myteam, notifications | 6 | 68 | [batch-people.md](batch-people.md) |
| settings/* | 7 | 49 | [batch-settings.md](batch-settings.md) |
| auth group + dashboard | 5 | 40 | [batch-auth.md](batch-auth.md) |
| chat, quickadd | 4 | 59 | [batch-chat.md](batch-chat.md) |
| reference pages (vehicles/index, jobs/[id]) | 2 | 8 | — |
| **total** | **47** | **388** | |

## What these tests do and do not cover

They are **render + gating + navigation** tests. Consistently across all batches:

- Covered: the screen renders, its empty state, its populated state from seeded
  rows, permission/role gating, `router.push` targets, and `Stack.Screen`
  header options.
- Not covered: multi-step write flows that finish behind a `confirmSheet`,
  network calls (`createUserOnline`, `resetUserPinOnline`, `verifyPinOnline`,
  demo-mode PATCH), camera/barcode scanning, image picking and upload, and
  drag-to-reorder. Sheets are usually asserted as *opened*, not submitted.
- Per-page specifics are in each batch ledger under "Shortcuts taken" — read
  that before assuming a page's behaviour is pinned down by a test.

## Harness issues the batch surfaced, and their status

| Issue | Status |
|---|---|
| `TooltipHint` never cleared its 6s dismiss timer, so it fired after teardown and crashed the jest worker | **Fixed in the component** (`src/components/TooltipHint.tsx`) — a real unmount leak, not a test problem. The three local `jest.mock`s of it were removed. |
| Screens that call `syncNow()` ran the real engine: `[Sync] Cycle error: Pull failed` noise + "worker process failed to exit gracefully" | **Fixed** — `test/jest.setup.ts` stubs `syncNow` via the engine module. Mocking the `@invenpro/core` barrel there instead would silently break test-local mocks; see PAGE-TESTS.md gotchas. |
| Docs gave jest path filters with unescaped `(app)`, which jest reads as a regex group and matches 0 files | **Fixed in PAGE-TESTS.md** (hit by 4 of 8 batches). |
| Docs claimed `permissions: { system_settings: false }` gates `full_admin`; it does not (`FULL_ADMIN_FLOOR`) | **Fixed in PAGE-TESTS.md**. Gating tests use a lower role. |
| `headerRight` elements are recorded in `stackScreenOptions` but not rendered, so each test re-implements pressing them | **Open** — a `pressHeaderRight()` helper in the router mock would remove the duplication. |
| `expo-secure-store` is mocked with the same 5-line in-memory Map in 4 auth test files | **Open** — a shared `test/mocks/secureStore.ts` would dedupe it. |
| Dynamic `await import()` in a test fails (no `--experimental-vm-modules`) | **Won't fix** — use static imports. |
