# Page tests: locations / lockers / vehicles / access batch

- locations/index.test.tsx: 9 tests
- locations/[id].test.tsx: 9 tests
- lockers/index.test.tsx: 7 tests
- lockers/[id].test.tsx: 5 tests
- vehicles/[id].test.tsx: 4 tests
- access/index.test.tsx: 9 tests

Total 43, all passing (`npx jest "app/\(app\)/locations" "app/\(app\)/lockers" "app/\(app\)/vehicles/\[id\]" "app/\(app\)/access"`).

## Shortcuts taken
- locations/index: the create form is only checked to open (title + name input); no submit/validation flow, no type-filter chips (needs taxonomy_types seeding).
- locations/[id]: no edit sheet, shelves, stock rows, move-stock or photo/activity sections.
- lockers/[id], vehicles/[id]: only the panel's headline sections are asserted; checkout/contents/access editing are not exercised.
- access: grant sheet only checked to open; revoke (confirmSheet) and Defaults sheet contents not exercised.
- Defaults-hidden test uses role hr_manager + manage_locations override, because full_admin has a non-overridable floor on system_settings.

## Harness gaps found
- None blocking. Note: jest path patterns are regexes, so the `(app)` parens must be escaped (`\(app\)`), not just quoted; the unescaped form silently matches 0 tests.
- Jest prints "worker failed to exit gracefully" after the run (open handle somewhere in the harness/pages); tests still pass.
