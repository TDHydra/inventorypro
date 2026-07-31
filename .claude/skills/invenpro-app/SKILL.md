---
name: invenpro-app
description: House conventions for building or changing ANYTHING in the InventoryPro app — new screens, forms, sheets, buttons, fields, lists, dashboards, feature work, styling tweaks, refactors, and debug instrumentation. Use this skill whenever you are about to write or modify code in apps/mobile (or its web twins), even for a "small" UI change or a one-off form — the recurring bugs here (#163, #168) came from skipping it. It covers which existing component to reuse instead of hand-rolling, the reactive-read and write patterns, permanent telemetry/activity logging, and the temporary debug-logging workflow.
---

# InventoryPro app conventions

The app is a component **kit**, not a pile of screens. Every regression wave
we've had (#163 safe-area misses, #168 duplicated form) traces back to building
something new that already existed. The job is: find the existing surface,
reuse or grow it, and wire the house patterns (reactivity, validation,
permissions, logging) from the start.

## The two prime rules

1. **Reuse before building.** Before writing any component, search
   `src/components/` (and `src/components/ui/`) for one that already does it.
   If a close-but-not-exact component exists, **alter or extend it** (add a
   prop, a variant, a slot) rather than forking a copy. If an existing form
   already edits the same entity, **grow that form** — never build a parallel
   one (the #168 lesson: GasReceiptSheet duplicated AddServiceRecordSheet and
   had to be merged away).

2. **Read the kit contract first**: `apps/mobile/src/components/ui/README.md`.
   It lists every kit component and the hard constraints (JS-only — no new
   native modules, web-safe RN primitives only, style via theme tokens, no
   icon libraries, no hardcoded hex).

## Pre-flight checklist for any UI/feature change

- **Scaffold**: full screen form → `FormScreen`; modal create/edit →
  `FormSheet` (title + scroll body + sticky FormActions + dirty-guard);
  plain bottom sheet → `ModalSheet`; single-entity edit → `EntityEditSheet`;
  list screen → `ListScreenShell`. Never hand-roll a Modal + backdrop.
- **Reads are reactive**: query via `useDbQuery(fn, deps, tables)` — never a
  bare `useMemo` over the DB unless it's a snapshot-on-open edit form (where
  reactivity would clobber user edits — the #163 lesson).
- **Writes**: local upsert + `appendOutbox` with the `synced_at` strip
  pattern, inside `runInTransaction` — see `references/data-patterns.md`.
- **Validation**: `src/lib/validation.ts` helpers (`validateText`,
  `parseOptionalCount`, …) — never ad-hoc regex/parseFloat.
- **Gates**: `usePermission('…')` for capability, `useMaintenanceMode().locked`
  for write lock — both, on every new write affordance.
- **Logging**: `track()` telemetry + `appendLog()` activity where the house
  does — see `references/logging.md` (also covers temp debug logging).
- **Web twin parity**: touching `ModalSheet.tsx`, `FormScreen.tsx`, or adding
  a migration? The `.web.tsx` / `schema.web.ts` twin MUST get the same change
  or web silently breaks.
- **Style**: `useThemedStyles(makeStyles)` + theme tokens only; named function
  components; inline `interface Props`; relative imports; comments reference
  the issue number (`// #168: …`) and explain constraints, not mechanics.
- **Android edge-to-edge**: bottom-pinned UI outside the kit scaffolds needs
  the safe-area/nav-bar inset (kit sheets bake it in; hand-rolled bars were
  the #163 bug class).

## References — read the one that matches the task

- `references/ui-kit.md` — component/hook inventory beyond the kit README:
  pickers, feature components, hooks, and their house conventions (e.g. the
  SearchablePicker toggle-onSelect idiom).
- `references/data-patterns.md` — useDbQuery, write/outbox/transaction
  patterns, validation, sync-migration checklist pointer.
- `references/logging.md` — telemetry `track()`, activity `appendLog()` (and
  its UUID-column trap), plus the tagged `// TEMP DEBUG` workflow and where
  logs actually appear (Metro log vs logcat vs release builds).

## Import hygiene

- Relative imports within `apps/mobile/src` (the house shape — no aliases).
- Never import a new native module (breaks hotload; the dev client doesn't
  have it). If a dependency seems needed, stop and say so — it forces a
  dev-client rebuild and is a user decision.
- Feature components import kit pieces from `../ui/…`; kit pieces never
  import feature components (no cycles).
- After moving/extending a component, run
  `pnpm exec tsc --noEmit` in `apps/mobile` — it is the import checker.

## Definition of done

`pnpm exec tsc --noEmit` and `pnpm test` green in `apps/mobile` (plus
`apps/api` if touched), temp debug logs stripped (`grep -rn "TEMP DEBUG"`
comes back empty), web twins updated, then hotload for user verification —
device confirmation is the only completion signal.
