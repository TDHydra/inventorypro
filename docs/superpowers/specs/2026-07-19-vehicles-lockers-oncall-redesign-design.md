# Vehicles/Lockers split, per-unit access, on-call rotation — design

**Date:** 2026-07-19 · **Epic:** #122 · **Approved by:** Matt (all four sections)

## Why

Field feedback on the first field-crew wave (#123–#128): vehicles and lockers modeled as
location sub-areas is the wrong product shape — they are fundamentally different from
places and need their own system. Plus: a single `water_state` can't represent the real
two-tank workflow, per-unit access is binary when it needs per-action control, and
on-call needs rotation + coverage instead of manual weekly assignment.

**Decision (approved):** separate **UX**, shared **storage**. Vehicles/lockers stay typed
`locations` rows (`type='Vehicle'/'Locker'`) with extension tables keyed by
`location_id`, so `stock_by_location`, sync, and checkout are untouched. Everything the
user sees is split.

## A. Vehicles & Lockers as their own system

- **Navigation/UI:** new dashboard widgets `vehicles` and `lockers` in `WIDGET_REGISTRY`
  (`apps/mobile/src/dashboard/widgets.ts`), own screens (redesigned list + detail;
  existing `VehiclePanel`/`LockerPanel` components in `apps/mobile/src/components/` are
  the starting point). Locations tab, browse, and main-location pickers **exclude**
  `type IN ('Vehicle','Locker')` everywhere (central filter in
  `apps/mobile/src/db/queries/locations.ts`).
- **Vehicle detail:** model (taxonomy #81), truck mount, **two tanks**, service records,
  checkout, and an inventory contents panel (add/remove/move stock in the vehicle,
  gated per-person — see B).
- **Two-tank model:** replace `vehicles.water_state` with two TEXT columns
  (PG-enum trap — never enums):
  - `water_tank`: `'full' | 'empty'`
  - `waste_tank`: `'dirty' | 'clean'` (clean = emptied + cleaned + filter replaced)
  Migration maps old values (`'full'`→water full, `'empty_clean'`→water empty +
  waste clean). Both sides: mobile migration (add to **both** `schema.ts` and
  `schema.web.ts` import arrays) + API migration.
- **No sub-areas on vehicles/lockers:** creation of a child under a Vehicle/Locker-typed
  parent is blocked (query guard + sync policy); one-time migration flattens the
  construction van's existing children (stock re-pointed to the van row, child rows
  retired).
- **Bug #129 (duplicate vehicles):** `findOrCreateVehicleByName`
  (`locations.ts:419`) dedupes only by local exact name → offline double-create.
  Fix: server-side normalized-name uniqueness for Vehicle-typed locations at push time
  (merge-into-existing on conflict) + one-time dedupe migration merging existing
  duplicates (stock, checkouts, service records re-pointed to the survivor).
- **Bug #130 (Frank's Locker invisible to Matt):** access resolution
  (`apps/mobile/src/access/accessResolution.ts`) = own ∪ granted ∪ same-team-owner;
  ownerless lockers are reachable only by explicit grant. Fix: manage contexts
  (Teams tab, unit managers, Production Managers/tier-3+) list all units; the new
  per-action grants (B) make day-to-day visibility explicit. Data fix: set Frank's
  Locker owner + grants.

## B. Per-action unit access with admin defaults

- **Table:** generalize `locker_access` → `unit_access` (both vehicles and lockers),
  PK `(location_id, user_id)`, boolean action columns:
  `can_view, can_add, can_remove, can_move, can_edit_details, can_grant`
  (+ `granted_by, updated_at`). Migration copies existing `locker_access` rows
  (existing grant → view+add+remove+move).
- **Defaults template:** admin-configured **per role**, stored in `app_config`
  (`unit_access_defaults`): e.g. Mitigation Technician → view+add+remove. Applied
  automatically when a grant is created; editable later per grant.
- **Who edits:** unit owner, team managers, Production Managers (tier rules follow
  `apps/api/src/lib/permissions.ts` `canActOnTarget`; server-enforced in
  `apps/api/src/routes/sync.ts` per-row guards like today's `locker_access`).
- **Where:** the Teams tab member row opens one permissions sheet combining the
  member's unit grants and their existing job/role overrides
  (`team_members.team_permission_overrides`) — one place for everything a person may do.
- **Dashboard editor:** when building a preset for a user/role, offer only widgets whose
  `requiredPermission` that target passes (`PermissionGate` stays as runtime backstop).

## B2. Per-role dashboard picker (added 2026-07-19)

- In the Role & Permissions page, under each role, an admin selects which dashboard
  preset that role automatically uses. Schema already exists
  (`039_dashboards.sql`: `dashboard_presets`, `role_settings.dashboard_preset_id`
  per-role, `users.dashboard_preset_id` per-user override, NULL → built-in default).
- UI: kit `SelectField` per role (active presets + "Default"); write guarded by the
  existing role-editing tier rules (`canEditRolePermission` idiom, server-enforced
  wherever `role_settings` writes are guarded).
- Reactivity: preset changes must propagate through the dashboard store without
  remount (`useSyncExternalStore` — the known module-cache gotcha).

## C. On-call: settings, rotation, coverage

- **Settings** (admin UI + `app_config`): `on_call_week_boundary` = day-of-week + hour
  (default **Thursday 08:00**), and an **ordered rotation list** of subteam ids
  (reorderable).
- **Rotation:** future weeks auto-fill by cycling the list (materialized into
  `on_call_shifts` N weeks ahead on read/assignment; `week_start` key becomes the
  boundary-based date). Manual per-week override sticks and does **not** shift the
  rest of the rotation.
- **Coverage/time-off:** new synced table `on_call_coverage(id, date_start, date_end,
  user_off, covering_user, note, created_by, created_at)`. UI: a PM-gated form in the
  on-call popup (`OnCallWidget`) — date picker (FormScreen/kit patterns), covering
  person, note. Writes gated by `manage_teams` + Production Manager role.
- **Notifications:** new channel `on_call` on the existing infra
  (`apps/api/src/lib/notifications.ts`, `push.ts`): on coverage save, notify other
  Production Managers ∪ `notify_route_on_call` recipients.

## D. Locations = main areas only

- Locations tab lists top-level real places; buildings keep sub-areas + shelves
  (`parent_id` nesting + `location_subtype` incl. Shelf — already shipped; polish the
  create-room/create-shelf flow under a building, e.g. Lexington Park → Maintenance
  Room / Product Room / Garage with shelves).

## Phases (board: one Backlog item per phase, linked here, under epic #122)

1. **A1** — schema: two-tank migration, unit_access table + copy, flatten van children,
   dedupe migration + server-side vehicle name uniqueness (#129).
2. **A2** — UX split: dashboard tiles, redesigned Vehicles/Lockers screens, locations
   filter, manage-context visibility (#130).
3. **B** — access defaults template + Teams-tab permissions sheet + dashboard editor
   filtering.
3b. **B2** — per-role dashboard preset picker in Role & Permissions (#136).
4. **C** — on-call settings + rotation autofill + coverage form + `on_call` channel.
5. **D** — locations polish (rooms/shelves flow).

Each phase: API + mobile migrations in lockstep (web `schema.web.ts` too), tests, then
dev-APK hotload verification on device before its board item moves past In review.

## Testing

- Unit: tank-state mapping, rotation fill (boundary math in `weekMath.ts`), access
  resolution with per-action grants, dedupe merge.
- API: sync-policy guards for `unit_access`/`on_call_coverage`, name-uniqueness push
  conflict, coverage notification fan-out.
- Device: per-phase hotload walkthrough (the standing completion signal for the board).
