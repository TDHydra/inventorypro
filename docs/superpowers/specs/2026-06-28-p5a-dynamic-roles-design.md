# P5 · 5a — Dynamic Roles & Permissions — Design Spec

*Date: 2026-06-28 · Branch: `feat/p5a-dynamic-roles` · Program P5, build 1 of 2 (5a; 5b follows).*

## Context

Today role→permission **assignment** is the compile-time `ROLE_DEFAULTS` constant (mirrored in
`apps/mobile/src/constants/roles.ts` and `apps/api/src/lib/permissions.ts`). Only per-user
`permission_overrides` (and per-team `team_permission_overrides`) are runtime. 5a makes the **role-level
assignment** runtime-editable + synced, so any capability can be turned on/off per role without a rebuild.

### Decisions locked with the user
- **Permission keys stay hardcoded** (new capabilities ship in code); only their **on/off assignment per role**
  becomes dynamic.
- **Store:** a `permission_overrides` JSONB/TEXT column on the existing synced `role_settings` table (PK=`role`),
  holding only **deviations** from `ROLE_DEFAULTS` (`{perm: bool}`); empty = pure default; toggling a cell back
  to its default **removes** the key (clean reset). Matches the existing JSONB-permission pattern.
- **Resolver precedence:** `ROLE_DEFAULTS → role override (new) → team override → user override`.
- **Self-lockout guard:** in the matrix, `manage_roles_permissions` and `system_settings` are ON and
  non-toggleable for `full_admin`.
- **Sequencing:** 5a ships fully (spec→build→review→merge→deploy) before 5b. The 5b `view_team_activity`
  permission key is added in 5b; the matrix is data-driven over the key list, so it picks up new keys
  automatically.

## Global Constraints
- Expo SDK 56; op-sqlite binds `string|number|null|ArrayBuffer`. **Migration 014; no native deps, no new permission.**
- Sync-migration checklist: `role_settings` is already synced (`ALLOWED_TABLES`/`FULL_TABLES`, conflict `role`);
  API pull is `SELECT *` + generic push upsert → **no `sync.ts` list edits**; only mobile `pull.ts`
  role_settings parity (3→4 cols).
- The 19 permission keys + `ROLE_DEFAULTS` are **duplicated** in mobile `constants/roles.ts` and api
  `lib/permissions.ts` — keep them identical; this build does NOT add/remove keys.
- TypeScript gate: `npx tsc --noEmit` clean (mobile + api).

## Shared Context Pack
- **Permission keys (19) + roles (13) + ROLE_DEFAULTS:** `apps/mobile/src/constants/roles.ts:16-35,173-187`
  (`Permission` union, `UserRole`, `ROLE_DEFAULTS`, `ROLE_TIER`); api mirror `apps/api/src/lib/permissions.ts:7-26,102-116`.
- **Mobile resolver:** `apps/mobile/src/auth/permissions.ts:29-51` `hasPermission(user, permission, teamId)`
  — currently `ROLE_DEFAULTS[role] → team_contexts override → user.permission_overrides`. Hook:
  `apps/mobile/src/hooks/usePermission.ts`.
- **Server resolver:** `apps/api/src/lib/permissions.ts:118-139` `userHasPermission(role, overrides, perm)` +
  `requirePermission(perm)` (queries `users.role, permission_overrides`; **2-level**, no role store yet).
- **role_settings:** `apps/api/src/db/migrations/001_initial_schema.sql:27-48` (PK `role`, `min_pin_length`,
  `updated_at`; seeded per role); mobile `apps/mobile/src/db/migrations/001_initial.ts:6-13`. Queries:
  `apps/mobile/src/db/queries/users.ts:69-76` `getRoleSettings()`, `:112-121` `setRoleMinPin()`.
- **Sync:** `role_settings` in `FULL_TABLES` (`sync.ts:41`), conflict `role` (`sync.ts:27`). Mobile pull
  `apps/mobile/src/sync/pull.ts:7,23` (3 cols today). JSONB-as-text pattern: see `users`/`team_members`
  rows in pull.ts (`JSON.stringify(row.x ?? {})`).
- **Admin UI:** `apps/mobile/app/(app)/(admin)/roles.tsx` (tier-4, `manage_roles_permissions`; min-PIN editor +
  read-only permission view) — extend with the matrix. `apps/mobile/app/(app)/(admin)/users.tsx:336-355,547-567`
  (per-user override toggles) — polish to diff vs dynamic role default.
- **Cache precedent:** the P1 decimals cache (`apps/mobile/src/constants/units.ts` `loadClassConfigCache()`,
  called at boot in `app/_layout.tsx` + after sync in `src/sync/engine.ts`) — mirror this exactly for role overrides.
- **Outbox:** `appendOutbox('UPDATE','role_settings',{...})`; real booleans; strip `synced_at`. Maintenance
  guards: `isWriteBlocked()`, `<MaintenanceBanner/>`, `disabled={locked}`.
- **Migrations:** current max = **013**; this is **014**.

---

## Architecture (units)

### Unit 1 — Migration 014 + sync parity
**Files:** `apps/api/src/db/migrations/014_role_permissions.sql`,
`apps/mobile/src/db/migrations/014_role_permissions.ts` (+ register v14 in `schema.ts`),
`apps/mobile/src/sync/pull.ts`.
- api: `ALTER TABLE role_settings ADD COLUMN IF NOT EXISTS permission_overrides JSONB NOT NULL DEFAULT '{}';`
- mobile: `ALTER TABLE role_settings ADD COLUMN permission_overrides TEXT NOT NULL DEFAULT '{}';` register v14.
- pull.ts: `role_settings` upsert → 4 cols / 4 placeholders adding `permission_overrides`; `rowToValues`
  append `JSON.stringify(row.permission_overrides ?? {})` (mirror users/team_members JSON handling).
- No seed (empty = ROLE_DEFAULTS).
- [ ] Controller: api+mobile tsc clean; commit `feat(db): migration 014 — role_settings.permission_overrides`.

### Unit 2 — Resolver: mobile role-override cache + server JOIN
**Files:** `apps/mobile/src/auth/permissions.ts`, `apps/mobile/src/db/queries/users.ts`,
`apps/mobile/app/_layout.tsx`, `apps/mobile/src/sync/engine.ts`, `apps/api/src/lib/permissions.ts`.
- **users.ts:** `getRolePermissionOverrides(): Record<string, Record<string, boolean>>` — read all
  `role_settings(role, permission_overrides)`, parse JSON (safe fallback `{}` on null/bad). `setRolePermission(role, perm, allowed | null)`
  — read-modify-write the role's override map (set key, or DELETE key when `allowed===null`), `INSERT OR REPLACE`
  preserving `min_pin_length`/`updated_at`, `appendOutbox('UPDATE','role_settings',{role, permission_overrides, updated_at})`
  (JSON object; strip synced_at).
- **permissions.ts (mobile):** module-level `roleOverridesCache: Record<string, Record<string, boolean>>` +
  `loadRolePermissionCache()` (reads `getRolePermissionOverrides()`, try/catch-safe). `hasPermission` gains a
  step between role-default and team: `if (roleOverridesCache[user.role] && perm in that) result = that[perm]`.
  Signature unchanged. Export `loadRolePermissionCache`.
- **_layout.tsx / engine.ts:** call `loadRolePermissionCache()` at boot (next to `loadClassConfigCache`) and
  after each sync (next to the existing post-pull cache refresh).
- **api/lib/permissions.ts:** extend `userHasPermission(role, userOverrides, perm, roleOverrides?)` to apply
  `roleOverrides[perm]` over the default, before the user override. `requirePermission` query becomes
  `SELECT u.role, u.permission_overrides, rs.permission_overrides AS role_overrides FROM users u
   LEFT JOIN role_settings rs ON rs.role = u.role WHERE u.id = $1` and passes `role_overrides` in. (Postgres
  `users.role` and `role_settings.role` are both the `user_role` enum — join directly.)
- [ ] Controller: api+mobile tsc clean; commit `feat(perms): role-override resolver (mobile cache + server join)`.

### Unit 3 — Roles & Permissions matrix UI
**Files:** `apps/mobile/app/(app)/(admin)/roles.tsx`.
- Add a **matrix**: for each role (iterate `ROLE_TIER`/`ROLE_DEFAULTS` keys) × each permission (iterate the
  `Permission` key list), a toggle showing the **effective** value (`ROLE_DEFAULTS[role][perm]` merged with the
  role override) and a "modified" badge when an override key exists. Toggling calls
  `setRolePermission(role, perm, newVal)` — and when `newVal === ROLE_DEFAULTS[role][perm]`, pass `null` to
  reset (remove the key). After write: `loadRolePermissionCache()` + `appendLog('role_permission_changed', …)`.
- **Self-lockout guard:** for `full_admin`, `manage_roles_permissions` and `system_settings` render ON and
  `disabled` (non-toggleable). 
- Maintenance guard: `isWriteBlocked()` early-return in the toggle handler; `<MaintenanceBanner/>`; toggles
  `disabled={locked}`. Keep the existing min-PIN editor. Use a horizontally scrollable grid or per-role
  expandable rows (reuse the existing expandable-role-card pattern in this file) so 13×19 stays usable.
- [ ] Controller: mobile tsc clean; commit `feat(admin): editable role→permission matrix + self-lockout guard`.

### Unit 4 — Per-user override polish
**Files:** `apps/mobile/app/(app)/(admin)/users.tsx`.
- The per-user override section currently diffs against `ROLE_DEFAULTS[role]`. Change the "override active"
  badge + effective display to diff against the **dynamic** effective role default (use the same role-override
  resolution — read `roleOverridesCache`/`getRolePermissionOverrides`), so a user override only shows as
  "modified" when it differs from the role's *current* effective value. No data-model change.
- [ ] Controller: mobile tsc clean; commit `feat(admin): user override diffs vs dynamic role default`.

---

## File map
| Unit | Files |
|---|---|
| 1 | `apps/api/src/db/migrations/014_role_permissions.sql`, `apps/mobile/src/db/migrations/014_role_permissions.ts`, `apps/mobile/src/db/schema.ts`, `apps/mobile/src/sync/pull.ts` |
| 2 | `apps/mobile/src/auth/permissions.ts`, `apps/mobile/src/db/queries/users.ts`, `apps/mobile/app/_layout.tsx`, `apps/mobile/src/sync/engine.ts`, `apps/api/src/lib/permissions.ts` |
| 3 | `apps/mobile/app/(app)/(admin)/roles.tsx` |
| 4 | `apps/mobile/app/(app)/(admin)/users.tsx` |

## Build order
Wave 0 (foundation): Unit 1 (migration+parity) + Unit 2 (resolver/cache/server) — file-disjoint, parallel.
Wave 1 (after Wave 0; depend on Unit 2 exports): Unit 3 (matrix UI), Unit 4 (users polish) — file-disjoint.

## Verification
- `tsc --noEmit` clean (mobile + api).
- Migration 014 applies: `role_settings.permission_overrides` exists (api JSONB, mobile TEXT default `'{}'`).
- Matrix: toggling a role's permission persists (outbox→server), survives a sync round-trip, and the change
  takes effect in `usePermission` (after cache reload) — e.g. grant `construction_crew` the `create_jobs`
  permission and confirm a crew member can now create a job; revoke and confirm gated again.
- Reset: toggling a cell back to its default removes the override key (role_settings.permission_overrides no
  longer contains it).
- Self-lockout guard: `manage_roles_permissions`/`system_settings` cannot be turned off for `full_admin`.
- Server enforcement: an API endpoint gated by `requirePermission` reflects a role-override grant/revoke
  (not just the mobile UI).
- Per-user override badge diffs against the dynamic role default (flip a role default, the user badge updates).

## Out of scope (5b + later)
- `view_team_activity` permission key + multi-manager teams + cross-team activity (5b).
- Editing the permission **key set** at runtime (keys stay hardcoded by decision).
- Team-level permission editing UI (team_permission_overrides exists; not part of 5a).
