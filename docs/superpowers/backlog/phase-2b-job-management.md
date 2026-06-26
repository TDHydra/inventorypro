# Backlog: Phase 2b — Job management + job-creation permissions

*Captured 2026-06-26 (from the Phase 2 scope discussion). Build after Phase 2a (equipment units).*

The user bundled these with "Phase 2" but they're a distinct subsystem from equipment
units. Build as its own spec → plan after 2a.

## Scope
1. **Crew cannot create jobs (tier-1).** Today checkout's "To Job" picker offers
   inline job creation to anyone. Gate it: only show/allow job creation when the user
   has `create_jobs`, and confirm `ROLE_DEFAULTS` has `create_jobs=false` for tier-1
   roles (construction_crew, contents_crew, mitigation_technician, carpet_cleaning_crew,
   temporary_employee). **Small + relevant to current testing — candidate to pull
   forward as a standalone fix.**
2. **Job detail screen** (`(jobs)/[id].tsx` is currently a stub): show the job's info,
   items/units deployed to it (from activity log + deployed units), media, and activity.
3. **Edit jobs** — rename, change status (open/closed/archived), via `PATCH /jobs/:id`
   (route exists). Gate on `create_jobs`/`close_jobs` as appropriate.
4. **Admin delete** — admins can delete entities (jobs first; consider items/locations).
   Note the existing Postgres gotcha: deleting a row referenced by `activity_log` fails
   because the append-only RULES break the FK integrity check — prefer **soft-delete**
   (`active=false` / `status='archived'`) over hard delete, or handle the rule
   temporarily server-side. Decide during 2b brainstorming.

## Open questions for 2b
- Soft-delete vs hard-delete (the activity_log FK/rule gotcha makes hard-delete painful).
- Which entities are admin-deletable (jobs only, or items/locations/users too)?
- Edit permissions matrix (who can rename/close/reopen/archive a job).
