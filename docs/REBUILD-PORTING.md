# mobile-v2 porting conventions (Waves A–D)

Read `docs/REBUILD-NOTES.md` first for phase status and environment. This file
is the mechanical rulebook for porting old-app code (`apps/mobile`) into
`apps/mobile-v2`. The old app is READ-ONLY reference — never edit it.

## Import mapping (old → new)

| Old (apps/mobile) | New (apps/mobile-v2) |
|---|---|
| `../db/schema` (getDb, rowsAs, bindParams) | `../db/schema` (exists in v2, same exports) |
| `../db/tx` (runInTransaction, queueTableBump) | `@invenpro/core` |
| `../sync/outbox` (appendOutbox, …) | **forbidden in screens** — writes go through a repo (`src/repos/*`); repos use `createRepository`/`mirror` from `@invenpro/core` |
| `../hooks/useDbQuery`, `useReactiveRows`, `useDataVersion` | `@invenpro/core` |
| `../db/appConfig`, `../db/appSettings` | `@invenpro/core` |
| `../sync/{connectivityStore,dataVersion,sandbox,denialMessages,…}` | `@invenpro/core` |
| `../components/ui/X` | `@invenpro/ui` (named export; whole kit re-exported from index) |
| `../themes/*` (useTheme, useThemedStyles, Theme, themeList) | `@invenpro/ui` |
| `../utils/{toastBus,alertBus}` + ConfirmSheet buses | `@invenpro/ui` |
| `../utils/uuid` (generateUUID) | `../utils/uuid` (exists in v2) |
| `../auth/permissions`, `usePermission` | same relative paths (exist in v2) |
| `../hooks/useSession` | same (exists in v2; NOTE: `.ts`, not `.tsx`) |
| `../db/queries/<domain>` | `../repos/<domain>` (see repo rules) |
| `../db/queries/log` (appendLog) | `../db/queries/log` (exists in v2) |
| route `/(app)/(dashboard)` | `/(app)` (hub is `app/(app)/index.tsx`) |

Relative-depth note: v2 keeps the same `src/` layout, so `../` depths usually
survive a straight copy of files into the same relative location.

## Repo rules (`apps/mobile-v2/src/repos/<domain>.ts`)

- Reads: copy the old query functions (SELECTs via `getDb()`/`rowsAs`)
  unchanged apart from import mapping.
- Writes: replace every hand-rolled `executeSync(INSERT/UPDATE/DELETE…) +
  appendOutbox(...)` pair with `createRepository('<table>')` calls:
  - whole-row upsert → `repo.insert(row)`
  - partial update (must include pk/conflict keys) → `repo.update(patch)`
  - delete → `repo.remove(keys)`
  - bespoke flows (stock ADJUST deltas, multi-row writes) → `repo.mirror(op,
    payload, () => { …raw local SQL… })`; call `queueTableBump` for any EXTRA
    tables the localWrite touches.
- Keep exported function names/signatures the old screens used, so screen
  ports only change the import path.
- `updated_at`/`created_at`: repos auto-fill when missing; drop manual stamps
  unless the value is semantic (e.g. client-supplied created_at for offline).
- Instantiate repositories at module scope is fine (manifest is static), but
  NEVER capture `getDb()` at module scope.

## Screen rules

- Location: `apps/mobile-v2/app/(app)/<area>/…` — e.g. `inventory/index.tsx`,
  `inventory/[id].tsx`, `locations/index.tsx`, `equipment/[id].tsx`,
  `manage-types.tsx`. No `(dashboard)` group.
- Copy the old screen, apply import mapping, and SLIM per the plan: drop
  demo/sandbox branches, dashboard-preset hooks, onboarding checklists,
  analytics viewers, broadcast, label template DESIGNER. Keep everything else
  working — the goal is a leaner file with identical domain behavior.
- Styles: keep `useThemedStyles(makeStyles)` + copied StyleSheet verbatim.
- Writes from screens go through `src/repos/*` only. If you need a write the
  repo doesn't expose yet, add it to the repo.
- Every screen must work on web too: if the old screen had a `.web.tsx` twin,
  port both; platform-specific native modules (camera, haptics) need the same
  guard pattern the old file used.
- After porting, `pnpm --filter mobile-v2 typecheck` must pass. Do not
  introduce `any` casts to silence errors — fix the import/type properly.

## Component rules

- Reusable domain components go to `apps/mobile-v2/src/components/` at the
  same relative path as the old app. Pure UI-kit components must NOT be
  copied — they're in `@invenpro/ui` already.
- If a component you need is missing from v2, copy it (with import mapping)
  rather than reimplementing; note any cut features in a header comment.

## Verification per work unit

1. `pnpm --filter mobile-v2 typecheck`
2. If you changed packages/core: `pnpm --filter @invenpro/core test`
3. Note what you ported + anything cut/deferred in `docs/REBUILD-NOTES.md`
   under "Wave A progress" (append; reconcile, don't overwrite).

## Known traps

- PG enum columns are TEXT on mobile — never "tighten" types.
- activity_log is immutable, insert-only; `login`/`pin_set` actions are
  server-written ONLY (client push is denied).
- op-sqlite params: use `bindParams`/`toBindable` from core (re-exported by
  `src/db/schema`) for undefined→null coercion.
- Root Stack remounts on theme change (`key={theme.id}`) — don't keep
  navigation-critical state only in component state across theme switches.
- Metro must not run under CI=1 (kills file watching).
