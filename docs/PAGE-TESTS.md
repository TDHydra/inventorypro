# Page render tests (apps/mobile-v2)

Render tests for the v2 route screens, using jest-expo + React Native Testing
Library against a real in-memory SQLite database.

## Two test runners, split by file extension

| Files | Runner | Command | What lives there |
|---|---|---|---|
| `src/**/*.test.ts` | `node --test` + tsx | `pnpm test:unit` | logic, repos, migrations (351 tests, pre-existing) |
| `app/**/*.test.tsx`, `src/**/*.test.tsx` | jest + RNTL | `pnpm test:pages` | page/component renders |

`pnpm test` runs both. **Never name a page test `*.test.ts`** — the node runner
would try to execute it and jest would ignore it.

The two runners are separate on purpose: the node suites swap `db/schema` with a
`Module._load` hook that has no jest equivalent, and they are green today. Do not
port them.

## Writing a page test

Reference examples — read one before starting:

- **List screen:** `app/(app)/vehicles/index.test.tsx`
- **`[id]` detail screen:** `app/(app)/jobs/[id].test.tsx`

```tsx
import { screen, fireEvent } from '@testing-library/react-native';
import { renderScreen } from '../../../test/renderScreen';
import { seed, initPageDb } from '../../../test/pageTestDb';
import { navCalls, setRouteParams, stackScreenOptions } from '../../../test/mocks/expoRouter';
import MyScreen from './index';

beforeEach(async () => { await initPageDb(); });   // fresh DB per test

test('renders the empty state', async () => {
  await renderScreen(<MyScreen />);
  expect(screen.getByText('Nothing here yet')).toBeOnTheScreen();
});
```

### RNTL v14 is async

`render`, `fireEvent`, `rerender` and `unmount` ALL return promises in v14.
`await` every one of them, and make the test function `async`. A missing `await`
shows up as a passing test that asserts nothing, or a stray act() warning in the
*next* test.

```tsx
await renderScreen(<MyScreen />);
await fireEvent.press(screen.getByText('Save'));
```

### The harness

| Helper | From | Purpose |
|---|---|---|
| `renderScreen(ui, opts)` | `test/renderScreen` | renders inside the app's real provider stack (SafeAreaProvider → KeyboardProvider → SessionContext) |
| `makeUser(opts)` | `test/renderScreen` | build a `UserSession` fixture |
| `seed(table, row)` | `test/pageTestDb` | insert a fixture row |
| `initPageDb()` | `test/pageTestDb` | drop + recreate every manifest table |
| `getDb()` | `test/pageTestDb` | the raw DB, to assert what a screen wrote |
| `navCalls` | `test/mocks/expoRouter` | every `router.push`/`replace`/`back` the screen made |
| `setRouteParams({ id })` | `test/mocks/expoRouter` | what `useLocalSearchParams()` returns — set it BEFORE rendering |
| `stackScreenOptions` | `test/mocks/expoRouter` | the `<Stack.Screen options>` the screen declared (header title etc.) |

`renderScreen` options: `role` (defaults `full_admin`), `permissions`
(user-level overrides, which beat role defaults — use these to test gating),
`user: null` (signed out), `previewRole`.

```tsx
// assert an affordance is permission-gated
await renderScreen(<InventoryScreen />, { permissions: { edit_inventory: false } });
expect(screen.queryByText('Add item')).not.toBeOnTheScreen();
```

### Seeding

`seed()` takes manifest column names. Get them from
`packages/core/src/manifest/tables.ts` — do not guess.

Foreign keys are suspended during `seed()` and restored for the render, so you
only need the row your screen renders, not its whole referenced graph. This
mirrors `packages/core/src/sync/pull.ts`, which brackets its own writes the same
way. The render itself runs with FKs ON, like the app.

## What to assert

Aim for ~4-8 tests per page, in this order of value:

1. **It renders at all** for the default admin session. This alone catches the
   #163-class crashes that shipped to the field.
2. **Empty state** — the screen with zero rows.
3. **Populated state** — seed 2-3 rows, assert they appear and that rows from a
   neighbouring kind/table do NOT (the vehicles-vs-lockers case).
4. **Permission gating** — a destructive or edit affordance hidden for a role
   that lacks it.
5. **Navigation** — tapping a row pushes the right route, via `navCalls`.
6. **Header** — `stackScreenOptions` contains the expected title.

Do not snapshot-test. Snapshots of these screens are thousands of lines, nobody
reviews the diff, and they fail on every unrelated theme tweak.

## Gotchas already paid for

- **`better-sqlite3`, not sql.js.** sql.js cannot run under jest-expo: the
  preset installs `@react-native/jest-preset`'s resolver, which resolves with the
  `browser` export condition and stubs node builtins, so sql.js picks its browser
  build and its Emscripten heap comes up unusable — the first
  `new SQL.Database()` dies with sqlite `"out of memory"`. Bisected: bare jest +
  the RN environment is fine; `preset: 'jest-expo'` alone reproduces it. The
  `node --test` suites still use sql.js and are untouched.
- **Single-instance modules.** `jest.config.js` maps `react`, `react-dom`,
  `react-native-safe-area-context` and `react-native-keyboard-controller` to the
  app's copy. pnpm otherwise gives `packages/core` its own React (19.1.0 vs the
  app's 19.2.3), and a hook called from `@invenpro/core` reads a different
  dispatcher: *"Cannot read properties of null (reading 'useSyncExternalStore')"*.
  Same class of failure for the context packages:
  *"No safe area value available"* from inside a `@invenpro/ui` component.
- **pnpm + `transformIgnorePatterns`.** A dep lives at
  `/node_modules/.pnpm/<pkg>@<v>/node_modules/<pkg>`, so the path has TWO
  `/node_modules/` segments and the `.pnpm` allowance only clears the first. Every
  ESM-only dep needs its own name in the allowlist (that is what `uuid` is doing
  there). Symptom: `SyntaxError: Unexpected token 'export'`.
- **No `extend-expect` import.** RNTL v14 registers `toBeOnTheScreen` and friends
  on plain import; the old `@testing-library/react-native/extend-expect` entry
  point no longer exists.
- **`*.test.tsx` IS typechecked.** `tsconfig.json` only excludes `*.test.ts`, so
  `pnpm typecheck` covers page tests. Jest globals come from
  `test/jest-globals.d.ts`.

## If a page needs something the harness lacks

Use a **local** `jest.mock()` inside your own test file. Do not edit
`jest.config.js`, `test/jest.setup.ts`, `test/pageTestDb.ts`,
`test/renderScreen.tsx` or `test/mocks/*` — those are shared, and concurrent
edits collide. Report the needed harness change instead.
