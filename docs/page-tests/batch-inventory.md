# Page tests: inventory batch

| Page | Test file | Tests |
|---|---|---|
| inventory/index | app/(app)/inventory/index.test.tsx | 7 |
| inventory/[id] | app/(app)/inventory/[id].test.tsx | 9 |
| inventory/low-stock | app/(app)/inventory/low-stock.test.tsx | 5 |
| checkout | app/(app)/checkout.test.tsx | 10 |
| scan | app/(app)/scan.test.tsx | 5 |
| manage-types | app/(app)/manage-types.test.tsx | 8 |

Total 44, all passing (6 suites).

## Shortcuts taken
- scan: the camera path (BarcodeScanner / expo-camera) is not exercised; tests cover the shell (mode toggle, USB panel, header, Cancel). `handleScanned` routing is untested.
- checkout: only the find step, find->qty transition, itemId param, check-in empty state and quick-source gating. The dest/confirm steps, submit, unit-tracked flow, PM flow and populated check-in panel are not covered.
- inventory/index: bulk-select action bar, pagination, pull-to-refresh and search-typing are not covered. Row navigation goes via the expanded ItemCard "Edit / details" action because the card header consumes the row tap.
- inventory/[id]: edit-mode save, adjust/move/add-stock sheets not exercised; only entry into edit mode.
- manage-types: add with a blank label asserts no row was written; no successful add/rename/archive/reorder (drag) tests.
- TooltipHint is mocked locally (see below) in checkout, scan and inventory/index tests.

## Harness gaps found
- `src/components/TooltipHint.tsx` schedules a dismiss timer that fires after jest tears down the environment ("import a file after the Jest environment has been torn down" / `Animated` undefined), crashing the worker. Worked around with a local `jest.mock` of TooltipHint in the three affected tests. Suggested harness fix: mock TooltipHint globally in test/jest.setup.ts, or use fake timers.
- Jest path filters are regexes: `"app/(app)/inventory"` matches nothing. Use `"app/\(app\)/inventory"` (escaped parens) when filtering by path.
- Jest prints "A worker process has failed to exit gracefully" on some runs (leaked timers); it does not fail the run.
