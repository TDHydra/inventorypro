# Role Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each role a color (per-role defaults + admin override synced via `role_settings`) and render every person's name in their role's color across the app.

**Architecture:** A nullable `color` column on `role_settings` (mobile + API), curated per-role default palette + a pure `resolveRoleColor` in `constants/roles.ts`, query helpers in `queries/users.ts` (`getRoleColorMap`, `roleColor`, `setRoleColor`), a swatch picker on the Roles admin screen, and tinted name `<Text>` at five render sites. Color is cosmetic — no reactive cache; admin edits appear on next render.

**Tech Stack:** Expo SDK 56 / React Native 0.85, op-sqlite (native) + sql.js (web) via the `SqlDb` interface, Fastify + Postgres API, outbox/pull sync.

## Global Constraints

- **No test runner exists.** The verification cycle is `npx tsc --noEmit -p tsconfig.json` (mobile) / `npx tsc --noEmit` (api), targeted `node -e` checks for pure functions, sync column/placeholder **parity** checks, and on-device/web verification. There is no jest/pytest.
- **Sync parity:** any change to a synced table's columns must keep `apps/mobile/src/sync/pull.ts` `TABLE_UPSERT_SQL` columns == `?` placeholders == `rowToValues` array length for that table. Follow `docs/SYNC-MIGRATION-CHECKLIST.md`.
- **pnpm only.** Never `npm install`.
- **Migration numbering:** next mobile = `022` (schema version becomes 22); next API = `025`.
- **op-sqlite isolation:** queries depend on the `SqlDb` interface / `getDb()` from `../schema`, never op-sqlite directly (keeps web working).
- **activity_log UUID rule:** `entity_id` is UUID-typed on the server; never log a role string there — set `entity_id: null` and put the role key in `note`/`metadata`.
- **Commit after every task.** Conventional commit messages; end with the Co-Authored-By line used on this branch.

---

### Task 1: Add `color` column to `role_settings` (mobile + API migrations)

**Files:**
- Create: `apps/mobile/src/db/migrations/022_role_color.ts`
- Modify: `apps/mobile/src/db/schema.ts` (register `m022`)
- Create: `apps/api/src/db/migrations/025_role_color.sql`

**Interfaces:**
- Produces: `role_settings.color TEXT` (nullable) on both DBs.

- [ ] **Step 1: Create the mobile migration**

`apps/mobile/src/db/migrations/022_role_color.ts`:
```ts
import type { SqlDb } from '../types';

export const migration = {
  version: 22,
  up: (db: SqlDb): void => {
    // Per-role name color. Nullable: NULL = use the code default (ROLE_COLORS).
    db.executeSync(`ALTER TABLE role_settings ADD COLUMN color TEXT`);
  },
};
```

- [ ] **Step 2: Register m022 in schema.ts**

In `apps/mobile/src/db/schema.ts`, after the `m021` import line add:
```ts
  const { migration: m022 } = await import('./migrations/022_role_color');
```
and add `m022` to the returned sorted array:
```ts
  return [m001, m002, m003, m004, m005, m006, m007, m008, m009, m010, m011, m012, m013, m014, m015, m016, m017, m018, m019, m020, m021, m022].sort((a, b) => a.version - b.version);
```

- [ ] **Step 3: Create the API migration**

`apps/api/src/db/migrations/025_role_color.sql`:
```sql
ALTER TABLE role_settings ADD COLUMN IF NOT EXISTS color TEXT;
```

- [ ] **Step 4: Typecheck mobile**

Run: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/src/db/migrations/022_role_color.ts apps/mobile/src/db/schema.ts apps/api/src/db/migrations/025_role_color.sql
git commit -m "feat(roles): add role_settings.color column (mobile m022 + api 025)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Default palette + resolver in `constants/roles.ts`

**Files:**
- Modify: `apps/mobile/src/constants/roles.ts` (add after `ROLE_DISPLAY_NAMES`)

**Interfaces:**
- Produces:
  - `ROLE_COLOR_PALETTE: string[]` — selectable swatches (superset of defaults).
  - `ROLE_COLORS: Record<UserRole, string>` — per-role default hex.
  - `ROLE_COLOR_FALLBACK: string` = `'#1E293B'`.
  - `resolveRoleColor(role: string, override?: string | null): string`.

- [ ] **Step 1: Add the palette, defaults, fallback, and resolver**

In `apps/mobile/src/constants/roles.ts`, immediately after the `ROLE_DISPLAY_NAMES` object:
```ts
// Curated colors readable as text on light surfaces (white / colors.surface).
// Used both as the admin swatch palette and as the per-role defaults below.
export const ROLE_COLOR_PALETTE: string[] = [
  '#C62828', '#AD1457', '#6A1B9A', '#4527A0', '#283593',
  '#1565C0', '#00838F', '#00695C', '#2E7D32', '#558B2F',
  '#EF6C00', '#5D4037', '#37474F', '#455A64',
];

// Neutral readable fallback (matches colors.textPrimary) for unknown/legacy roles.
export const ROLE_COLOR_FALLBACK = '#1E293B';

// Per-role default name color. Distinct, drawn from ROLE_COLOR_PALETTE. Admins
// can override per role (role_settings.color); NULL override → these defaults.
export const ROLE_COLORS: Record<UserRole, string> = {
  full_admin:               '#C62828',
  franchise_manager:        '#6A1B9A',
  hr_manager:               '#AD1457',
  office_manager:           '#283593',
  head_of_construction:     '#EF6C00',
  head_of_contents:         '#5D4037',
  production_manager:       '#1565C0',
  carpet_cleaning_manager:  '#00695C',
  construction_crew:        '#37474F',
  contents_crew:            '#00838F',
  mitigation_technician:    '#1E3A5F',
  carpet_cleaning_crew:     '#558B2F',
  temporary_employee:       '#455A64',
};

// Effective name color for a role: explicit override → role default → neutral.
export function resolveRoleColor(role: string, override?: string | null): string {
  const o = override?.trim();
  if (o) return o;
  return ROLE_COLORS[role as UserRole] ?? ROLE_COLOR_FALLBACK;
}
```
(Note `'#1E3A5F'` for `mitigation_technician` is the one default not in the palette list — that is intentional and fine; defaults need not all be in the swatch set. The picker still shows the palette and marks a swatch active only when it matches.)

- [ ] **Step 2: Verify the resolver with node**

Run:
```bash
cd apps/mobile && npx tsc --noEmit -p tsconfig.json && \
node -e "const t=require('@babel/core').transformFileSync('src/constants/roles.ts',{presets:['babel-preset-expo']}).code; const m={}; const f=new Function('exports','module',t); f(m,{exports:m}); console.log(m.resolveRoleColor('full_admin'), m.resolveRoleColor('full_admin','#000000'), m.resolveRoleColor('nope'));"
```
Expected: prints `#C62828 #000000 #1E293B` (default, override wins, fallback). If the `node -e` transform is awkward in your environment, it is sufficient to rely on `tsc` exit 0 plus the device check in Task 7.

- [ ] **Step 3: Commit**

```bash
git add apps/mobile/src/constants/roles.ts
git commit -m "feat(roles): role color palette, per-role defaults, resolveRoleColor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Query helpers in `queries/users.ts`

**Files:**
- Modify: `apps/mobile/src/db/queries/users.ts` (add near `getRoleSettings` / `setRoleMinPin`)

**Interfaces:**
- Consumes: `resolveRoleColor` from `../../constants/roles`; `getDb` from `../schema`.
- Produces:
  - `getRoleColorMap(): Record<string, string>` — role → non-null override color.
  - `roleColor(role: string, map?: Record<string, string>): string`.
  - `setRoleColor(role: string, color: string | null): string` — returns new `updated_at`.

- [ ] **Step 1: Add the import**

At the top of `apps/mobile/src/db/queries/users.ts`, ensure this import exists (add if missing):
```ts
import { resolveRoleColor } from '../../constants/roles';
```

- [ ] **Step 2: Add the helpers (after `getRoleSettings`)**

```ts
// Role → override color (only non-null overrides). Callers build this ONCE per
// screen and pass it to roleColor() per row to avoid per-row DB reads.
export function getRoleColorMap(): Record<string, string> {
  const db = getDb();
  const result = db.executeSync(`SELECT role, color FROM role_settings WHERE color IS NOT NULL`);
  const map: Record<string, string> = {};
  for (const row of result.rows as { role: string; color: string | null }[]) {
    if (row.color) map[row.role] = row.color;
  }
  return map;
}

// Effective name color for a role. Pass a prebuilt map in hot lists.
export function roleColor(role: string, map?: Record<string, string>): string {
  const override = (map ?? getRoleColorMap())[role];
  return resolveRoleColor(role, override);
}

// Set (or clear, with null) a role's override color. Returns new updated_at.
export function setRoleColor(role: string, color: string | null): string {
  const db = getDb();
  const now = new Date().toISOString();
  db.executeSync(
    `INSERT INTO role_settings (role, color, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(role) DO UPDATE SET color = excluded.color, updated_at = excluded.updated_at`,
    [role, color, now]
  );
  return now;
}
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/db/queries/users.ts
git commit -m "feat(roles): getRoleColorMap / roleColor / setRoleColor helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Sync parity for `role_settings.color` (`pull.ts`)

**Files:**
- Modify: `apps/mobile/src/sync/pull.ts` (`TABLE_UPSERT_SQL.role_settings` + `rowToValues` case)

**Interfaces:**
- Consumes: pulled `role_settings` rows now include `color`.

- [ ] **Step 1: Add `color` to the upsert SQL**

In `apps/mobile/src/sync/pull.ts`, change the `role_settings` entry of `TABLE_UPSERT_SQL` from:
```ts
  role_settings: `INSERT OR REPLACE INTO role_settings (role, min_pin_length, permission_overrides, updated_at) VALUES (?, ?, ?, ?)`,
```
to:
```ts
  role_settings: `INSERT OR REPLACE INTO role_settings (role, min_pin_length, permission_overrides, color, updated_at) VALUES (?, ?, ?, ?, ?)`,
```

- [ ] **Step 2: Add `color` to `rowToValues`**

Change the `role_settings` case from:
```ts
    case 'role_settings': return [row.role, row.min_pin_length, JSON.stringify(row.permission_overrides ?? {}), row.updated_at];
```
to:
```ts
    case 'role_settings': return [row.role, row.min_pin_length, JSON.stringify(row.permission_overrides ?? {}), row.color ?? null, row.updated_at];
```

- [ ] **Step 3: Parity check + typecheck**

Run:
```bash
cd apps/mobile
grep -n "role_settings:" src/sync/pull.ts
npx tsc --noEmit -p tsconfig.json
```
Expected: the `INSERT` lists **5** columns and **5** `?`; the `rowToValues` array has **5** elements; tsc exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/src/sync/pull.ts
git commit -m "feat(roles): sync role_settings.color (pull.ts parity 5/5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Color picker on the Roles admin screen

**Files:**
- Modify: `apps/mobile/app/(app)/(admin)/roles.tsx`

**Interfaces:**
- Consumes: `ROLE_COLOR_PALETTE`, `resolveRoleColor` from `src/constants/roles`; `getRoleColorMap`, `setRoleColor` from `src/db/queries/users`; `appendOutbox`, `appendLog` (already imported).

- [ ] **Step 1: Add imports**

Add to the existing imports in `roles.tsx`:
```ts
import { ROLE_COLOR_PALETTE, resolveRoleColor } from '../../../src/constants/roles';
import { getRoleColorMap, setRoleColor } from '../../../src/db/queries/users';
```
(Extend the existing `ROLE_DISPLAY_NAMES, ROLE_TIER, ...` import from `constants/roles` and the `getRoleSettings, setRoleMinPin, ...` import from `queries/users` rather than duplicating module imports.)

- [ ] **Step 2: Track the override map in state**

Near the other role-settings state in the component, add:
```ts
const [roleColors, setRoleColors] = useState<Record<string, string>>(() => getRoleColorMap());
```

- [ ] **Step 3: Add the change handler**

Add alongside the existing `setRoleMinPin`/permission handlers:
```ts
function changeRoleColor(role: UserRole, color: string | null) {
  const now = setRoleColor(role, color);
  setRoleColors(getRoleColorMap()); // refresh local map → preview + swatches update
  appendOutbox('UPDATE', 'role_settings', { role, color, updated_at: now });
  appendLog({
    action: 'role_settings',
    entity_type: 'role_settings',
    entity_id: null,
    user_id: null,
    team_id: null,
    from_location_id: null,
    to_location_id: null,
    quantity: null,
    unit: null,
    job_id: null,
    note: `${role} color → ${color ?? 'default'}`,
    metadata: null,
    device_id: null,
  });
}
```
(Match the exact `appendLog` field set used by the existing min-pin handler in this file; copy its shape if it differs.)

- [ ] **Step 4: Render the swatch row + preview in the expanded role card**

Inside each role's expanded card (where min-pin / permissions render), add a Color section. `role` is the current row's `UserRole`; `effective` is the resolved color:
```tsx
{(() => {
  const effective = resolveRoleColor(role, roleColors[role]);
  return (
    <View style={s.colorSection}>
      <Text style={s.pinLabel}>Name color</Text>
      <Text style={[s.colorPreview, { color: effective }]}>{ROLE_DISPLAY_NAMES[role]}</Text>
      <View style={s.colorRow}>
        {ROLE_COLOR_PALETTE.map(c => (
          <TouchableOpacity
            key={c}
            style={[s.colorCell, { backgroundColor: c }, effective === c && s.colorCellActive]}
            onPress={() => changeRoleColor(role, c)}
          >
            {effective === c && <Text style={s.colorCheck}>✓</Text>}
          </TouchableOpacity>
        ))}
      </View>
      {!!roleColors[role] && (
        <TouchableOpacity onPress={() => changeRoleColor(role, null)}>
          <Text style={s.colorReset}>Reset to default</Text>
        </TouchableOpacity>
      )}
    </View>
  );
})()}
```

- [ ] **Step 5: Add styles**

In the `StyleSheet.create({...})` for this screen, add:
```ts
colorSection: { paddingHorizontal: spacing.base, paddingVertical: spacing.sm, gap: spacing.sm },
colorPreview: { fontSize: fontSizes.base, fontWeight: '700' },
colorRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
colorCell: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
colorCellActive: { borderWidth: 3, borderColor: colors.textPrimary },
colorCheck: { color: '#fff', fontSize: fontSizes.body, fontWeight: '800' },
colorReset: { fontSize: fontSizes.caption, color: colors.primaryText, fontWeight: '600' },
```

- [ ] **Step 6: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add "apps/mobile/app/(app)/(admin)/roles.tsx"
git commit -m "feat(roles): color swatch picker + preview on Roles admin screen

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Tint names at the five render sites

**Files:**
- Modify: `apps/mobile/app/(auth)/login.tsx`
- Modify: `apps/mobile/app/(app)/(dashboard)/index.tsx`
- Modify: `apps/mobile/app/(app)/(admin)/users.tsx`
- Modify: `apps/mobile/app/(app)/(teams)/[id].tsx`
- Modify: `apps/mobile/app/(app)/(logs)/index.tsx`

**Interfaces:**
- Consumes: `roleColor`, `getRoleColorMap` from `src/db/queries/users` (correct relative depth per file).

- [ ] **Step 1: Login picker — tint the roster name**

In `apps/mobile/app/(auth)/login.tsx`:
- Add import: `import { roleColor, getRoleColorMap } from '../../src/db/queries/users';`
- Build the map once: `const roleColors = useMemo(() => getRoleColorMap(), []);`
- In the picker row render, change the name `<Text style={styles.userName2}>` to:
  ```tsx
  <Text style={[styles.userName2, { color: roleColor(item.role, roleColors) }]}>{item.name}</Text>
  ```
- Also tint the selected-user heading on the PIN/setpin screens: change `<Text style={styles.userName}>{selectedUser.name}</Text>` (both occurrences) to:
  ```tsx
  <Text style={[styles.userName, { color: roleColor(selectedUser.role, roleColors) }]}>{selectedUser.name}</Text>
  ```

- [ ] **Step 2: Dashboard greeting — tint the name**

In `apps/mobile/app/(app)/(dashboard)/index.tsx`:
- Add import: `import { roleColor } from '../../../src/db/queries/users';`
- Change line 32 `<Text style={styles.hi}>Hi, {user.name.split(' ')[0]}</Text>` to:
  ```tsx
  <Text style={[styles.hi, { color: roleColor(user.role) }]}>Hi, {user.name.split(' ')[0]}</Text>
  ```
  (Single user → direct `roleColor(user.role)` call is fine; `user` comes from the session and has `role`. The greeting sits on `colors.background` (light), so palette colors are readable.)

- [ ] **Step 3: Users admin list — tint each name**

In `apps/mobile/app/(app)/(admin)/users.tsx`:
- Add import: `import { roleColor, getRoleColorMap } from '../../../src/db/queries/users';`
- Build once in the component: `const roleColors = useMemo(() => getRoleColorMap(), []);`
- On the list-row user name `<Text>`, add `{ color: roleColor(u.role, roleColors) }` to its style array (where `u` is the row's user object, which has `.role`).

- [ ] **Step 4: Team member list — tint each member name**

In `apps/mobile/app/(app)/(teams)/[id].tsx`:
- Add import: `import { roleColor, getRoleColorMap } from '../../../src/db/queries/users';`
- Build once: `const roleColors = useMemo(() => getRoleColorMap(), []);`
- If a member row already carries `role`, tint its name `<Text>` with `{ color: roleColor(member.role, roleColors) }`. If members are loaded WITHOUT a role field, also build a userId→role lookup once: `const userRoles = useMemo(() => Object.fromEntries(getAllUsers().map(u => [u.id, u.role])), []);` (import `getAllUsers` from `../../../src/db/queries/users`) and tint with `{ color: roleColor(userRoles[member.user_id] ?? '', roleColors) }`. Use whichever matches the existing member shape; do not add a per-row DB query.

- [ ] **Step 5: Activity log — tint the actor name**

In `apps/mobile/app/(app)/(logs)/index.tsx`:
- Add import: `import { roleColor, getRoleColorMap, getAllUsers } from '../../../src/db/queries/users';`
- Build once: `const roleColors = useMemo(() => getRoleColorMap(), []);` and `const userRoles = useMemo(() => Object.fromEntries(getAllUsers().map(u => [u.id, u.role])), []);`
- On the entry's actor/user name `<Text>`, add `{ color: roleColor(userRoles[entry.user_id] ?? '', roleColors) }` to its style array (where `entry.user_id` is the log row's user id). When `user_id` is null/unknown, `roleColor('')` returns the neutral fallback — correct.

- [ ] **Step 6: Typecheck**

Run: `cd apps/mobile && npx tsc --noEmit -p tsconfig.json`
Expected: exit 0. (If a site's row object lacks the assumed field, adjust to the actual field name shown by tsc / the surrounding code — keep the `roleColor(role, roleColors)` call shape.)

- [ ] **Step 7: Commit**

```bash
git add "apps/mobile/app/(auth)/login.tsx" "apps/mobile/app/(app)/(dashboard)/index.tsx" "apps/mobile/app/(app)/(admin)/users.tsx" "apps/mobile/app/(app)/(teams)/[id].tsx" "apps/mobile/app/(app)/(logs)/index.tsx"
git commit -m "feat(roles): tint names by role color at login, dashboard, users, teams, logs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Deploy API migration + end-to-end verification

**Files:** none (deploy + verify).

- [ ] **Step 1: Typecheck both packages**

Run:
```bash
cd apps/api && npx tsc --noEmit && cd ../mobile && npx tsc --noEmit -p tsconfig.json
```
Expected: both exit 0.

- [ ] **Step 2: Deploy the API (migration 025) to Unraid**

Per `infra/DEPLOY-COMMANDS.md` "Updating later":
```bash
cd /home/tdpotato/inventorypro
docker build --provenance=false -f apps/api/Dockerfile -t inventorypro-api:latest .
docker save inventorypro-api:latest | gzip > inventorypro-api.tar.gz
scp inventorypro-api.tar.gz root@192.168.1.239:/mnt/user/appdata/inventorypro/
ssh root@192.168.1.239 'cd /mnt/user/appdata/inventorypro && docker load -i inventorypro-api.tar.gz && docker compose -f docker-compose.prod.yml up -d api'
```

- [ ] **Step 3: Confirm the column exists + health**

Run:
```bash
ssh root@192.168.1.239 "docker exec inventorypro-postgres-1 psql -U inventorypro -d inventorypro -c \"\\d role_settings\" | grep color"
ssh root@192.168.1.239 'curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/health'
```
Expected: a `color | text` row; health `200`.

- [ ] **Step 4: Hotload mobile + device check**

Per `deploy-android` §B (dev client + Metro, `EXPO_PUBLIC_API_URL=https://api.plexcontrol.com CI=1`). On device:
1. Sign in. Open Roles admin → expand a role (e.g. Production Manager) → pick a new swatch. Confirm the live preview recolors and "Reset to default" appears.
2. Confirm a person with that role shows the new name color on: the login picker (sign out), the dashboard greeting (sign in as them), the Users admin list, a team they're on, and an activity-log entry they created.
3. Confirm sync: the `role_settings` color round-trips to prod (check the sync dot / a second device or the server row).

- [ ] **Step 5: Final commit (if any verification fixes were needed)**

```bash
git add -A && git commit -m "fix(roles): address role-color verification findings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```
(Skip if Step 4 surfaced nothing.)

---

## Self-Review

**Spec coverage:** data model (Task 1) ✓; defaults/resolver (Task 2) ✓; read helpers incl. `setRoleColor` (Task 3) ✓; admin picker + preview + outbox/log (Task 5) ✓; colored names at all five sites (Task 6) ✓; sync parity (Task 4) ✓; deploy + contrast/device verification (Task 7) ✓. Contrast guard: the only flagged risk site (dashboard greeting) is confirmed on a light background, so no per-site fallback is needed; other sites are light surfaces.

**Placeholder scan:** no TBD/TODO; every code step shows full code; the two conditional render sites (teams/logs) give the exact fallback (`userId→role` map via `getAllUsers`) rather than "handle it".

**Type consistency:** `resolveRoleColor(role, override?)`, `getRoleColorMap(): Record<string,string>`, `roleColor(role, map?)`, `setRoleColor(role, color|null): string` are used with identical signatures across Tasks 2/3/5/6. `ROLE_COLOR_PALETTE`/`ROLE_COLORS`/`ROLE_COLOR_FALLBACK` names consistent. `role_settings` column order (role, min_pin_length, permission_overrides, color, updated_at) consistent between migration intent and pull.ts parity (5 fields).
