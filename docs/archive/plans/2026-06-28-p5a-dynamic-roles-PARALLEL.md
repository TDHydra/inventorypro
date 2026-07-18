# P5 · 5a — Dynamic Roles & Permissions — Implementation Plan

> Ultramode/SDD. Gate per task: `npx tsc --noEmit` clean (mobile + api). Implementers do NO git/tsc.

**Goal:** runtime-editable, synced role→permission assignment. New precedence
`ROLE_DEFAULTS → role override → team override → user override`; admin matrix UI; server enforcement.
One migration (014); no native deps. **Full spec:** `docs/superpowers/specs/2026-06-28-p5a-dynamic-roles-design.md`
— ships with every brief.

## Global Constraints
- Expo SDK 56; op-sqlite binds `string|number|null|ArrayBuffer`. **Migration 014; no native, no new permission key** (keys stay hardcoded).
- `role_settings` already synced (conflict `role`) → only mobile `pull.ts` parity (3→4 cols); no `sync.ts` list edits.
- The 19 permission keys + ROLE_DEFAULTS are duplicated in mobile `constants/roles.ts` and api `lib/permissions.ts` — keep identical; do NOT add/remove keys here.
- Outbox: real booleans, strip `synced_at`. Maintenance guards: `isWriteBlocked()`, `<MaintenanceBanner/>`, `disabled={locked}`.
- Mirror the P1 decimals-cache pattern (`loadClassConfigCache` in units.ts, called in `_layout.tsx` + `engine.ts`).

---

# WAVE 0 (foundation, parallel, file-disjoint)

### Task 1: Migration 014 + sync parity
**Files:** `apps/api/src/db/migrations/014_role_permissions.sql`, `apps/mobile/src/db/migrations/014_role_permissions.ts`,
`apps/mobile/src/db/schema.ts`, `apps/mobile/src/sync/pull.ts`.
- api: `ALTER TABLE role_settings ADD COLUMN IF NOT EXISTS permission_overrides JSONB NOT NULL DEFAULT '{}';`
- mobile: `ALTER TABLE role_settings ADD COLUMN permission_overrides TEXT NOT NULL DEFAULT '{}';` register v14 in schema.ts.
- pull.ts: role_settings upsert → 4 cols/4 placeholders (add `permission_overrides`); rowToValues append
  `JSON.stringify(row.permission_overrides ?? {})`. Verify parity. No seed.
- [ ] Controller: api+mobile tsc clean; commit `feat(db): migration 014 — role_settings.permission_overrides`.

### Task 2: Resolver — mobile cache + server JOIN
**Files:** `apps/mobile/src/db/queries/users.ts`, `apps/mobile/src/auth/permissions.ts`,
`apps/mobile/app/_layout.tsx`, `apps/mobile/src/sync/engine.ts`, `apps/api/src/lib/permissions.ts`.
- users.ts: `getRolePermissionOverrides(): Record<string, Record<string,boolean>>` (parse role_settings JSON,
  safe `{}` fallback); `setRolePermission(role, perm, allowed: boolean | null)` (read-modify-write the role's
  map; `null` removes the key; INSERT OR REPLACE preserving min_pin_length/updated_at; outbox UPDATE role_settings
  with the JSON object, no synced_at).
- permissions.ts (mobile): module-level `roleOverridesCache` + `loadRolePermissionCache()` (try/catch-safe);
  `hasPermission` applies `roleOverridesCache[user.role][perm]` AFTER role default, BEFORE team override.
  Signature unchanged. Export the loader.
- _layout.tsx + engine.ts: call `loadRolePermissionCache()` at boot + after each sync (beside the decimals cache).
- api/lib/permissions.ts: `userHasPermission(role, userOverrides, perm, roleOverrides?)` applies roleOverrides
  over default before the user override; `requirePermission` query →
  `SELECT u.role, u.permission_overrides, rs.permission_overrides AS role_overrides FROM users u
   LEFT JOIN role_settings rs ON rs.role = u.role WHERE u.id = $1`, pass role_overrides in.
- [ ] Controller: api+mobile tsc clean; commit `feat(perms): role-override resolver (mobile cache + server join)`.

# WAVE 1 (after Wave 0; depend on Unit 2 exports; file-disjoint)

### Task 3: Roles & Permissions matrix UI
**Files:** `apps/mobile/app/(app)/(admin)/roles.tsx`.
- Matrix: roles × 19 permissions toggles showing the EFFECTIVE value (ROLE_DEFAULTS merged with role override)
  + a "modified" badge where an override key exists. Toggle → `setRolePermission(role, perm, newVal)`, passing
  `null` when `newVal === ROLE_DEFAULTS[role][perm]` (reset). After write: `loadRolePermissionCache()` +
  `appendLog('role_permission_changed', …)`.
- Self-lockout guard: `full_admin` shows `manage_roles_permissions` + `system_settings` ON and `disabled`.
- Maintenance guard (`isWriteBlocked()` early-return, `<MaintenanceBanner/>`, `disabled={locked}`). Keep the
  min-PIN editor. Reuse the existing expandable-role-card layout so 13×19 stays usable.
- [ ] Controller: mobile tsc clean; commit `feat(admin): editable role→permission matrix + self-lockout guard`.

### Task 4: Per-user override polish
**Files:** `apps/mobile/app/(app)/(admin)/users.tsx`.
- The per-user override "override active" badge + effective display diff against the DYNAMIC effective role
  default (resolve via roleOverridesCache/getRolePermissionOverrides), not raw ROLE_DEFAULTS. No data-model change.
- [ ] Controller: mobile tsc clean; commit `feat(admin): user override diffs vs dynamic role default`.

# SHIP (controller)
- [ ] App-wide tsc; whole-branch review (opus): migration 014 cross-platform + pull.ts parity (4/4); resolver
  precedence correct on BOTH mobile (cache between role-default and team) and server (JOIN merge before user
  override); cache loaded at boot + after sync; matrix writes deviations + reset removes key; self-lockout guard
  on full_admin; outbox/maintenance conventions; no permission keys added/removed. Merge → main, push.
  **Deploy:** migration 014 → API redeploy to Unraid (verify schema_migrations=14). Re-confirm role_settings
  enum-free (it's JSONB/TEXT — no enum trap, unlike 012).

## Self-Review
- Spec coverage: U1→T1; U2→T2; U3→T3; U4→T4. ✔
- Collision: T1 migrations+schema.ts+pull.ts; T2 permissions.ts(mobile)+users.ts(queries)+_layout+engine+lib/permissions.ts(api); T3 roles.tsx; T4 users.tsx. pull.ts only T1; resolver files only T2; UI files split T3/T4. ✔
- Risk: T2 server JOIN correctness (enum join) + mobile cache precedence ordering; final review verifies both
  resolvers honor role overrides identically.
