# Page tests: equipment, repairs & media batch

- `equipment/index.test.tsx` - 6 tests
- `equipment/[id].test.tsx` - 8 tests
- `repairs/index.test.tsx` - 8 tests
- `repairs/[id].test.tsx` - 8 tests
- `media/index.test.tsx` - 8 tests

Total: 38, all passing.

## Shortcuts taken
- Only open/render paths are covered. Sheets and modals (new-model save, bulk actions, use-parts, log-step, add-units, MediaDetailSheet) are not driven.
- Media row tap -> MediaDetailSheet is not tested; the FAB is only asserted present.
- `repairs/[id]` Overdue is asserted with `getAllByText` because the badge text appears more than once.
- Maintenance-lock (`locked`) variants are not covered.
- Equipment/[id] title is the model name when found ('Equipment' only when not found); tests assert both.

## Harness gaps found
- None needing a change.
- Jest path patterns are regexes, so the quoted `"app/(app)/equipment"` matches nothing. Use `"\(app\)/equipment"`.
- `seed('users', ...)` needs `pin_length_required` (NOT NULL, no default).
