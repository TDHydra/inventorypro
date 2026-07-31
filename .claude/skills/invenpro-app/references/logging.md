# Logging — permanent instrumentation + temporary debug logs

Two completely different systems. Permanent = telemetry + activity log,
shipped with the feature. Temporary = tagged console logs for a debugging
session, stripped before commit.

## Permanent 1: telemetry `track()`

`import { track } from '../../telemetry'` —
`track(type, name, { screen?, props? })`, types `screen | action | error |
audit`. Never throws, never blocks, separate lossy pipeline (NOT the sync
outbox). Screen views are automatic via `useScreenTracking`; add manual calls
for:

- **Validation rejects** (the house idiom — every form does this):
  ```ts
  track('audit', 'validation_reject', { screen: 'vehicle_service', props: { field, rule } });
  ```
- **Notable actions** the office may ask about later (`'action'`, named
  `thing_verbed`: `receipt_saved`, `stock_adjusted`).
- Props are redacted/sanitized automatically, but still: ids and enums in
  props, never free text a user typed.

## Permanent 2: activity log `appendLog()`

`src/db/queries/log.ts` — the synced, user-visible audit trail (Activity
feed). Log what a coworker would want to see happened (created/moved/
checked-out), not UI minutiae. Traps:

- `action` / `entity_type` MUST be in the server enums
  (`ACTIVITY_ACTIONS` / `ACTIVITY_ENTITY_TYPES` in
  `apps/api/src/lib/syncPolicy.ts`) or every push permanently conflicts.
  Adding a new action = server enum change FIRST, deployed before devices
  use it.
- `entity_id`, `user_id`, `team_id`, `job_id`, location ids are **UUID
  columns**. Logging a string key (a role name, a taxonomy key) there fails
  every push with "invalid input syntax for type uuid" — set `entity_id:
  null` and put the string in `note` / `metadata`.
- Prod `activity_log` is append-only (no UPDATE/DELETE) — never design a
  feature that edits log rows.

## Temporary: the debug-logging workflow

When chasing a bug that needs on-device evidence:

1. Add `console.log` at each suspect stage, **tagged per component** with
   bracketed initials so the stream is greppable:
   `console.log('[SP] row pressIn', o.label)` (SearchablePicker),
   `console.log('[ASR] forPick', prev, '->', next)` (AddServiceRecordSheet).
   Log state transitions (`old -> new`), not just "got here".
2. Mark EVERY such line with a trailing `// TEMP DEBUG` comment.
3. Where the output appears:
   - **Dev client + Metro**: console output streams into the Metro log
     (`/tmp/metro-<port>.log`) — `tail -f` it, or
     `adb logcat -d ReactNativeJS:I '*:S'`.
   - **Release APKs do NOT emit `console.*` at all** — for release-only bugs
     instrument the SERVER side (push conflicts, activity log) instead.
4. Hotload (Fast Refresh applies on save), reproduce, read the log.
5. **Strip before commit**: `grep -rn "TEMP DEBUG" apps/mobile/src` must
   come back empty. Never ship debug logs — `__DEV__`-guarded noise still
   costs and rots.

If a log line turns out to be permanently useful, it isn't TEMP — promote it
to `track()`/`appendLog()` per above, with a real name.
