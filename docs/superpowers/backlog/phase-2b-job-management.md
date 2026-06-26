# Phase 2b — Complete activity logging  +  (later) Job management

*Updated 2026-06-26 per user: logging is the Phase 2b deliverable; the
job-management features are pushed to the general backlog (NOT required for 2b).*

## Phase 2b (next, after Phase 2a): finish ALL logging
Make the immutable activity log complete and viewable — the accountability backbone.

1. **Every action logs.** Audit every mutation path and ensure it writes an
   `activity_log` entry via `appendLog` (which now self-syncs). Cover at minimum:
   add_stock, add_units, checkout_to_job, transfer, consumed, checkin, repair_out,
   repair_in, plus user create / role & permission changes / PIN set & reset /
   location create / item create & edit / job create & edit. Anything that changes
   state should leave a trail. Fill gaps where a screen mutates without logging.
2. **Log viewing screens.** Complete `(logs)/index.tsx` (global feed with
   date/user/action/location filters) and per-entity logs: item log, location log,
   job log, user log — each readable from its detail screen. Resolve names
   (user/item/location/job) and show asset tags from the `note` for unit moves.
3. **Server log feed.** Confirm `apps/api/src/routes/logs.ts` returns the joined,
   filterable feed the screens need (it already joins `inventory_items` on
   `entity_type='item'`).

## General backlog — Job management (later, NOT Phase 2b)
Pushed out per user; pick up after 2b when prioritized.
- **Crew cannot create jobs (tier-1).** Gate checkout's inline "create job" behind
  `create_jobs`; confirm `ROLE_DEFAULTS` has `create_jobs=false` for tier-1 roles
  (construction_crew, contents_crew, mitigation_technician, carpet_cleaning_crew,
  temporary_employee). Small + isolated.
- **Job detail screen** (`(jobs)/[id].tsx` is a stub): info + items/units deployed +
  media + activity.
- **Edit jobs** (rename, status open/closed/archived) via `PATCH /jobs/:id`.
- **Admin delete.** Prefer soft-delete (`status='archived'` / `active=false`) — the
  append-only `activity_log` RULES break FK integrity checks on hard DELETE of a
  referenced row (documented gotcha). Decide entities + soft-vs-hard during its own
  brainstorming.

## Also in the general backlog
- `location-aware-ux.md` (foreground location pre-select).
- Phase 2a deferrals: equipment maintenance history (dates/costs/scheduled service),
  auto-generated asset tags, printable label templates.
