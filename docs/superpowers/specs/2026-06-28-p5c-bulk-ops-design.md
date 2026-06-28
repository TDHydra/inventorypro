# P5 · 5c (Phase 1) — Bulk Multi-Select Ops — Design Spec

*Date: 2026-06-28 · Branch: `feat/p5c-bulk-ops` · Program P5, build 3 (5c, phase 1 of 3).*

## Context

Add a **reusable multi-select + batch-action framework** and apply it to the **Users** and **Jobs** lists.
This is phase 1 of a broader bulk-select vision (the user wants multi-select across users, jobs, inventory,
and equipment). Phase 1 builds the reusable pieces and wires the two lists with actions that need **no new
fields and no new dependencies**.

### Decisions locked with the user
- **Phasing:** Phase 1 = framework + Users + Jobs. Phase 2 (later) = Inventory + Equipment. Phase 3 (later) =
  Jobs **Insurance** field (migration) + Users **Send push** (needs P3 Notifications). Not in this build.
- **UX:** long-press a row to enter selection mode; tap rows to toggle; a sticky **bulk-action bar** shows the
  count + actions + a select-all and a cancel/exit.
- **Users actions:** Deactivate / Reactivate, Change role, Add to a team, Reset PIN.
- **Jobs actions:** Close, Archive, Reopen, Set job type.
- Every batch action = iterate the selected ids and call the **existing per-entity mutation** (each emits its
  own outbox entry), so changes sync exactly like the single-row edits already do.

## Global Constraints
- Expo SDK 56 (RN 0.85.3). **No migration, no native dep, no new permission, no sync-table change.** JS-only →
  reaches the dev client over Metro; APK rebuild after merge.
- Outbox correctness (the user is sensitive to sync): user writes must pair the local update with
  `appendOutbox('UPDATE','users',{ id, …fields, updated_at })` using **real booleans** (`active: !!v`), never
  0/1, and never include `synced_at`. Job writes go through the existing outbox-wired helpers.
- Preserve maintenance guards: batch actions early-return on `isWriteBlocked()`; the bar is disabled when `locked`.
- Permission-gate: Users bulk → `manage_users`; Jobs status bulk → `close_jobs` (and `create_jobs` for reopen/type),
  matching the existing single-row gates on those screens.
- TypeScript gate: `npx tsc --noEmit` clean (mobile).

## Shared Context Pack
- **Existing mutations (reuse — do NOT reinvent):**
  - `src/db/queries/users.ts`: `updateUserLocal(id, fields)` (LOCAL only — must be paired with an outbox UPDATE,
    see `users.tsx:181-182,224-225`); `getAllUsers()`. Reset PIN is server-online: `resetUserPinOnline(userId)`
    in `app/(app)/(admin)/users.tsx:90-99` (`PATCH/POST /users/:id {reset_pin:true}` with the JWT) + local
    `markUserPinReset(id)`.
  - `src/db/queries/jobs.ts`: `updateJobFields(id, fields)` (sets status/type/… + `appendOutbox('UPDATE','jobs',…)`,
    line 144); `archiveJob(id)` (status='archived' + outbox); `getAllJobs(showArchived)`.
  - `src/db/queries/teams.ts`: `addTeamMember(teamId, userId, overrides?, addedBy?)` (INSERT OR IGNORE + outbox).
  - `src/db/queries/taxonomy.ts`: `getTaxonomyTypes('job')` for the job-type picker; `getProductClasses` n/a here.
- **Screens:** `app/(app)/(admin)/users.tsx` (FlatList of `getAllUsers()`, `renderItem` ~line 396, `manage_users`
  gating, `useMaintenanceMode`/`isWriteBlocked`, edit modal); `app/(app)/(jobs)/index.tsx` (FlatList, status
  filter, `usePermission('create_jobs')`, `getAllJobs`).
- **UI primitives:** `ui/*` (PrimaryButton/AppInput/ModalSheet/FieldLabel), `SearchablePicker` (role/team/type
  pickers), `theme.ts`, `useMaintenanceMode`/`isWriteBlocked`, `appendLog`.

---

## Architecture (units)

### Unit 1 — Reusable multi-select framework
**Files:** `apps/mobile/src/hooks/useMultiSelect.ts` (new), `apps/mobile/src/components/BulkActionBar.tsx` (new).
- `useMultiSelect<T extends { id: string }>()` → `{ active, selected: Set<string>, count, isSelected(id),
  enter(id?), toggle(id), selectAll(ids), clear(), exit() }`. `enter` turns on selection mode (optionally
  selecting the long-pressed row); `exit` clears + leaves mode.
- `BulkActionBar`: sticky bottom bar, shown when selection mode is active. Props: `{ count, actions:
  Array<{ key; label; destructive?; onPress() }>, onSelectAll?, onCancel, disabled? }`. Renders "N selected",
  a Select-all, a Cancel, and the action buttons (destructive styled red). `disabled` greys actions (maintenance).
- No business logic here — pure, reusable for phase 2 (inventory/equipment) too.
- [ ] Controller: mobile tsc clean; commit `feat(bulk): reusable useMultiSelect + BulkActionBar`.

### Unit 2 — Users list bulk actions
**Files:** `apps/mobile/src/db/queries/users.ts` (add helpers), `app/(app)/(admin)/users.tsx`.
- **users.ts helpers** (DRY the local+outbox pattern): `setUserActive(id, active: boolean)` and
  `setUserRole(id, role: string)` — each does `updateUserLocal(id, {…})` + `appendOutbox('UPDATE','users',
  { id, …, updated_at })` with a **real boolean** for `active`, no `synced_at`. Return `updated_at`.
- **users.tsx:** wire `useMultiSelect` (long-press a user row → selection mode; tap toggles; row shows a
  selected check). Render `BulkActionBar` (gated `manage_users`) with:
  - **Deactivate / Reactivate** — for each selected, `setUserActive(id, false/true)` (offer both; or a single
    toggle that deactivates active ones / reactivates inactive — simplest: two explicit actions).
  - **Change role** — open a role `SearchablePicker` (roles from `ROLE_DEFAULTS`/`ROLE_TIER` keys with
    `ROLE_DISPLAY_NAMES`); apply `setUserRole(id, role)` to each.
  - **Add to team** — open a team `SearchablePicker` (`getAllTeams`); `addTeamMember(teamId, id, {}, me)` each.
  - **Reset PIN** — `confirm` then `await resetUserPinOnline(id)` + `markUserPinReset(id)` sequentially; show a
    success/failure count; requires connectivity (surface an error if offline). 
  - Each handler: `if (isWriteBlocked()) return;`, run, `appendLog`, refresh the list, `exit()` selection.
- [ ] Controller: mobile tsc clean; commit `feat(bulk): user list batch actions (deactivate/role/team/reset-pin)`.

### Unit 3 — Jobs list bulk actions
**Files:** `app/(app)/(jobs)/index.tsx`.
- Wire `useMultiSelect` (long-press a job → selection mode; tap toggles). Render `BulkActionBar` (gated
  `create_jobs`/`close_jobs`) with:
  - **Close** — `updateJobFields(id, { status: 'closed' })` each (only meaningful for open jobs).
  - **Archive** — `archiveJob(id)` each.
  - **Reopen** — `updateJobFields(id, { status: 'open' })` each.
  - **Set type** — job-type `SearchablePicker` (`getTaxonomyTypes('job')`); `updateJobFields(id, { type })` each.
  - Each handler: `isWriteBlocked()` guard, run, `appendLog`, reload list, `exit()`.
- [ ] Controller: mobile tsc clean; commit `feat(bulk): job list batch actions (close/archive/reopen/set-type)`.

---

## File map
| Unit | Files |
|---|---|
| 1 | `apps/mobile/src/hooks/useMultiSelect.ts`, `apps/mobile/src/components/BulkActionBar.tsx` (new) |
| 2 | `apps/mobile/src/db/queries/users.ts`, `app/(app)/(admin)/users.tsx` |
| 3 | `app/(app)/(jobs)/index.tsx` |

## Build order
Wave 0: Unit 1 (framework). Wave 1 (parallel, file-disjoint): Unit 2 (users), Unit 3 (jobs).

## Verification
- `tsc --noEmit` clean (mobile).
- Long-press a user → selection mode; select several; Deactivate → those users go inactive AND sync (outbox
  UPDATE with real boolean active=false); Reactivate works; Change role applies to all selected and syncs; Add
  to team adds memberships; Reset PIN resets each (online) with a result count.
- Long-press a job → select several; Close/Archive/Reopen set status and sync; Set type applies the chosen job
  type and syncs.
- Maintenance lock disables the bulk-action bar; permission-gated (non-managers don't see user bulk actions).
- Single-row edit/flows on both screens still work unchanged; selection mode exits cleanly (cancel + after action).

## Out of scope (phase 2/3)
- Inventory + Equipment multi-select (phase 2 — reuse the same framework).
- Jobs **Insurance** field (phase 3 — migration). Users **Send push** (phase 3 — needs P3 Notifications).
- "Quick generate" actions (e.g. bulk QR/asset-tag) — phase 2+.
