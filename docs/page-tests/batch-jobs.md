# Page tests: jobs & scheduling batch (39 tests, all passing)

- `app/(app)/jobs/index.tsx` - 8 tests
- `app/(app)/schedule/index.tsx` - 6 tests (via DayBoardScreen)
- `app/(app)/approvals/index.tsx` - 6 tests
- `app/(app)/oncall/index.tsx` - 7 tests
- `app/(app)/oncall/settings.tsx` - 5 tests
- `app/(app)/logs/index.tsx` - 7 tests

## Shortcuts taken
- jobs: bulk multi-select (long-press), the Set-type picker, the QuickCreateSheet and pull-to-refresh are not exercised. The New Job FAB is only asserted present/absent, not tapped.
- jobs: My Checkouts populated state not tested (needs inventory_items + unit_tracked join); only its empty state.
- schedule: board chips, cell taps, picker sheet and popups are not exercised; only the crew roster, empty state, header and expand-toggle gating.
- oncall: week grid contents (OnCallCalendar) and CoverageSheet are not asserted; settings select/drag/reorder writes are not exercised.
- approvals: Deny path (confirmSheet) not tested; Approve asserted through the DB row.
- logs: action/entity SearchablePicker filters not exercised.

## Harness gaps found
- No harness change needed.
- Gating note: `permissions: { system_settings: false }` does NOT hide system_settings-gated UI for the default full_admin role (admin-locked). Use `role: 'construction_crew'` instead. `manage_teams`, `create_jobs` and `manage_schedule` overrides do work on full_admin.
- Jest path patterns are regexes: `npx jest "app/(app)/jobs/index"` matches nothing ("No tests found"). Escape the parens: `npx jest 'app/\(app\)/jobs/index'`.
- Dynamic `await import()` inside a test fails (no --experimental-vm-modules); use static imports.
- Jest prints "A worker process has failed to exit gracefully" after the run (open timer somewhere); tests still pass.
