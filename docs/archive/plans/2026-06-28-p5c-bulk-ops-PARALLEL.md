# P5 · 5c (Phase 1) — Bulk Multi-Select Ops — Implementation Plan

> Ultramode/SDD. Gate per task: `npx tsc --noEmit` clean (mobile). Implementers do NO git/tsc.

**Goal:** a reusable multi-select + batch-action framework, applied to the Users and Jobs lists. No migration,
no native, no new sync table. **Full spec:** `docs/superpowers/specs/2026-06-28-p5c-bulk-ops-design.md` — ships
with every brief.

## Global Constraints
- Expo SDK 56 (RN 0.85.3). JS-only. Batch actions wrap EXISTING per-entity mutations (each already syncs).
- **Outbox correctness:** user writes pair the local update with `appendOutbox('UPDATE','users',{id,…,updated_at})`
  using REAL booleans (`active: !!v`), no `synced_at`. Job writes use the existing outbox-wired helpers
  (`updateJobFields`/`archiveJob`).
- Maintenance guards: every batch handler early-returns on `isWriteBlocked()`; the bar is `disabled={locked}`.
- Permission gates: Users bulk → `manage_users`; Jobs status/type bulk → `close_jobs`/`create_jobs`.

---

# WAVE 0 (foundation)

### Task 1: Reusable framework
**Files:** `apps/mobile/src/hooks/useMultiSelect.ts`, `apps/mobile/src/components/BulkActionBar.tsx` (new).
- `useMultiSelect<T extends {id:string}>()` → `{ active, selected:Set<string>, count, isSelected(id),
  enter(id?), toggle(id), selectAll(ids), clear(), exit() }`.
- `BulkActionBar` props `{ count, actions: {key,label,destructive?,onPress}[], onSelectAll?, onCancel, disabled? }`
  — sticky bottom bar with "N selected" + Select-all + Cancel + action buttons (destructive = red); greyed when disabled.
- Pure/reusable (phase 2 will reuse for inventory/equipment). No business logic.
- [ ] Controller: mobile tsc clean; commit `feat(bulk): reusable useMultiSelect + BulkActionBar`.

# WAVE 1 (parallel after Wave 0; file-disjoint)

### Task 2: Users list batch actions
**Files:** `apps/mobile/src/db/queries/users.ts`, `app/(app)/(admin)/users.tsx`.
- users.ts: add `setUserActive(id, active:boolean)` and `setUserRole(id, role:string)` — each `updateUserLocal`
  + `appendOutbox('UPDATE','users',{id,…,updated_at})` (real boolean active, no synced_at); return updated_at.
  (Mirror the existing inline pattern at users.tsx:181-182,224-225.)
- users.tsx: wire `useMultiSelect` (long-press row → selection mode, tap toggles, selected check on the row);
  render `BulkActionBar` (gated `manage_users`, `disabled={locked}`) with: Deactivate, Reactivate (setUserActive),
  Change role (role SearchablePicker → setUserRole each), Add to team (team SearchablePicker via getAllTeams →
  addTeamMember each), Reset PIN (confirm → sequential `await resetUserPinOnline(id)` + `markUserPinReset(id)`,
  show success/fail count, handle offline). Each handler: `isWriteBlocked()` guard, run, `appendLog`, refresh, `exit()`.
  Keep the existing edit modal + single-row flows intact.
- [ ] Controller: mobile tsc clean; commit `feat(bulk): user list batch actions`.

### Task 3: Jobs list batch actions
**Files:** `app/(app)/(jobs)/index.tsx`.
- Wire `useMultiSelect` (long-press → selection mode, tap toggles). Render `BulkActionBar` (gated
  `create_jobs`/`close_jobs`, `disabled={locked}`) with: Close (`updateJobFields(id,{status:'closed'})`),
  Archive (`archiveJob(id)`), Reopen (`updateJobFields(id,{status:'open'})`), Set type (job-type SearchablePicker
  from `getTaxonomyTypes('job')` → `updateJobFields(id,{type})`). Each handler: `isWriteBlocked()` guard, run,
  `appendLog`, reload, `exit()`. Keep existing filters + single-row nav intact.
- [ ] Controller: mobile tsc clean; commit `feat(bulk): job list batch actions`.

# SHIP (controller)
- [ ] App-wide tsc; whole-branch review (opus): framework reusability + correctness; selection UX (enter/toggle/
  select-all/exit) at scale; EVERY batch user write pairs local+outbox with REAL booleans + no synced_at (sync
  correctness); job writes use the outbox-wired helpers; permission + maintenance gates on the bar; Reset PIN
  online/offline handling + result count; no regression to single-row flows. Merge → main, push. JS-only → APK
  rebuild (no prod deploy).

## Self-Review
- Spec coverage: U1→T1; U2→T2; U3→T3. ✔
- Collision: T1 new files; T2 users.ts+users.tsx; T3 jobs/index.tsx. Wave-1 disjoint. ✔
- Risk: T2 sync correctness (local+outbox pairing, real booleans) — the final review must verify bulk user
  changes actually sync, mirroring the single-row pattern.
