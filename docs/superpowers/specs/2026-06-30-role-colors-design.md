# Spec — Role colors (color-coded names)

## Goal
Give each role a color, and render every person's **name** in their role's color
across the app. Colors have sensible per-role defaults and are editable by admins
on the existing Roles screen. Color is cosmetic only — it never gates behavior.

## Decisions (from brainstorming)
- **Where:** everywhere a person's name shows — login picker, dashboard greeting,
  Users admin list, team member lists, and activity-log "who did it" attribution.
- **Style:** the name **text** is tinted (normal weight) from a curated, readable
  palette. Not free-form hex.
- **Source:** per-role defaults in code + optional admin override stored (and
  synced) in `role_settings`. Effective = override ?? default ?? safe fallback.

## Data model
- **Mobile migration `apps/mobile/src/db/migrations/022_role_color.ts`** (new):
  `ALTER TABLE role_settings ADD COLUMN color TEXT`. Register `m022` in
  `apps/mobile/src/db/schema.ts` (import + push into the sorted array, mirroring
  `m021`). Schema version becomes **22**.
- **API migration `apps/api/src/db/migrations/025_role_color.sql`** (new):
  `ALTER TABLE role_settings ADD COLUMN IF NOT EXISTS color TEXT;`
- `color` is nullable; `NULL` = use the code default for that role.

## Defaults & resolution (`apps/mobile/src/constants/roles.ts`)
- Add `ROLE_COLORS: Record<UserRole, string>` — 13 distinct hex colors chosen to
  be readable on light surfaces (`colors.surface` / white). Grouping for clarity:
  tier-4 admins/managers in warm tones, tier-2/3 managers in mid tones, tier-1
  crews in cool tones. (Exact hexes finalized in the plan; all dark enough for
  AA-ish contrast on white.)
- Add a pure resolver:
  `export function resolveRoleColor(role: string, override?: string | null): string`
  → `override?.trim() || ROLE_COLORS[role as UserRole] || ROLE_COLOR_FALLBACK`.
  `ROLE_COLOR_FALLBACK` is a hardcoded neutral readable hex (`#1E293B`, matching
  `colors.textPrimary`) exported from the same file so `constants/` stays
  dependency-free of the theme module. Unknown/legacy roles therefore render in
  the neutral color, never blank/invalid.

## Reading the override (`apps/mobile/src/db/queries/users.ts`)
- `export function getRoleColorMap(): Record<string, string>` — `SELECT role, color
  FROM role_settings` → map of role → non-null override color (skip NULLs).
- `export function roleColor(role: string, map?: Record<string,string>): string` —
  convenience: `resolveRoleColor(role, (map ?? getRoleColorMap())[role])`. Screens
  rendering lists build the map **once** (e.g. `useMemo(() => getRoleColorMap(), [])`)
  and pass it into `roleColor(role, map)` per row to avoid per-row DB reads.
- `export function setRoleColor(role: string, color: string | null): string` —
  upsert `role_settings.color` + bump `updated_at`; returns the new `updated_at`
  (mirrors `setRoleMinPin`). Caller appends the outbox UPDATE + activity log.
- No reactive cache: color is cosmetic, so an admin's change appearing on the next
  navigation/render is acceptable (consistent with how `getRoleSettings` is read).

## Admin UI (`apps/mobile/app/(app)/(admin)/roles.tsx`)
- In each role's expanded card, add a **Color** row: a horizontal swatch picker
  reusing the `locations` `COLOR_OPTIONS` cell pattern (`colorCell` / `colorCellActive`
  / `colorCheck`), seeded with the curated `ROLE_COLORS` palette values, plus the
  current effective color shown selected.
- A live preview: the role's display name rendered in the currently-selected color.
- On select: `setRoleColor(role, color)` →
  `appendOutbox('UPDATE','role_settings',{ role, color, updated_at })` → activity
  log entry (mirror the existing `setRoleMinPin` / `setRolePermission` handlers;
  `entity_type:'role_settings'`, `entity_id:null` per the activity_log UUID rule —
  put the role key in `note`/`metadata`).
- Optional "Reset to default" affordance = `setRoleColor(role, null)`.

## Applying colored names (shared, per render site)
Tint the name `<Text>` with `{ color: roleColor(user.role, map) }`. Sites:
- `app/(auth)/login.tsx` — picker row name (`userName2`). Roster rows carry `role`
  already (`RosterUser`), so build the map once in the screen.
- Dashboard greeting — the signed-in user's name (uses `session.role`).
- `app/(app)/(admin)/users.tsx` — Users list name.
- `app/(app)/(teams)/[id].tsx` (and `(teams)/index.tsx` if it lists members) —
  member names.
- `app/(app)/(logs)/index.tsx` — the actor/"who" name on each entry (only where a
  role is resolvable for that user; otherwise default text color).
Each site needs the user's `role` available; where a list has only names/ids,
resolve role from the already-loaded user row (no extra query in hot loops).

## Sync / migration parity (`apps/mobile/src/sync/pull.ts`)
- `TABLE_UPSERT_SQL.role_settings`: add `color` column + one `?`
  (`(role, min_pin_length, permission_overrides, color, updated_at)`).
- `rowToValues` `role_settings` case: append `row.color ?? null` in the matching
  position. Keep column/placeholder parity.
- `/sync/full` + first-launch `applyRows` handle `role_settings` generically
  (`Object.keys`) — no change needed; confirm.
- API `apps/api/src/routes/sync.ts`: `role_settings` upserts dynamically — no
  change. `color` is a normal (non-privileged-gated beyond the existing
  `manage_roles_permissions` table gate) column.

## Contrast / readability
- Palette is curated dark-enough hexes for light backgrounds.
- The **dashboard greeting** may sit on a tinted/dark header — verify on device.
  If a role color is unreadable there, that one site falls back to the existing
  header text color (a small per-site guard), rather than weakening the palette.

## Verification
- `tsc --noEmit` clean (mobile + api). `pull.ts` parity check (role_settings
  5 cols / 5 placeholders / 5 rowToValues).
- Deploy API (migration 025); confirm `role_settings.color` exists; health ok.
- Rebuild/hotload: on device, change a role's color in the Roles screen → that
  role's people show the new name color on the login picker, Users list, teams,
  and logs; sync round-trips `color` to prod and to a second device.

## Out of scope
- Free-form hex / custom color entry (curated palette only).
- Coloring the role-label text itself or backgrounds/badges (names only).
- Per-user color overrides (role-level only).
