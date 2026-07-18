# Settings Core + Hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`. **Verification gate:** no unit-test runner — gate per task is `npx tsc --noEmit` clean (controller, app-wide) + the task's manual check. Implementer agents do **NO git and NO tsc**; the controller runs unified tsc, commits per task, reviews.

**Goal:** Build the real Settings screen (Account/logout, Sync now+status, App info, Idle auto-logout), fix the accumulated review-minor hardening, and add a sync-migration checklist.

**Architecture:** A manual `syncNow()` is exported from the sync engine (+ a double-start guard); the Settings screen + an idle-logout hook consume it; hardening + shared-constant extraction + a docs checklist round it out. JS-only — no migration/native (ships over Metro).

**Tech Stack:** Expo SDK 56, expo-router, `@op-engineering/op-sqlite`, `expo-constants` (already present, v56.0.18), Fastify (api one-line).

## Global Constraints

- Expo SDK 56 — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- op-sqlite bind params: only `string | number | null | ArrayBuffer`.
- No DB migration, no native module, no new permission. Settings prefs persist in the existing local `app_settings` (key/value).
- Clearing the session auto-redirects to login via the `(app)/_layout.tsx` `!user` guard — logout = call the session-context logout (`clearSession()`).
- Full Shared Context Pack in the spec: `docs/superpowers/specs/2026-06-26-settings-core-design.md` — every brief ships with it.

---

# WAVE 0 (T1, T3, T4 disjoint — parallel) → then T2

### Task 1: Sync engine — `syncNow()` + double-start guard

**Files:** Modify `apps/mobile/src/sync/engine.ts`
**Produces:** `export async function syncNow(): Promise<void>` (runs one `syncCycle()`); `startSyncEngine` becomes idempotent.
- [ ] **Step 1:** Add `export async function syncNow(): Promise<void> { await syncCycle(); }` (reuse the existing internal `syncCycle`).
- [ ] **Step 2:** Add a module-level `let started = false;`. In `startSyncEngine`, `if (started) return; started = true;` at the top (so a second call can't add a second interval / duplicate NetInfo+AppState listeners). In `stopSyncEngine`, set `started = false` (after clearing timers/listeners).
- [ ] **Step 3 (controller): verify** `npx tsc --noEmit` clean.
- [ ] **Step 4 (controller): commit** `feat(sync): export syncNow() + idempotent startSyncEngine guard`.

### Task 3: Hardening — api guard return, logs dev-log, ActivityFeed memo

**Files:** Modify `apps/api/src/lib/permissions.ts`, `apps/mobile/app/(app)/(logs)/index.tsx`, `apps/mobile/src/components/ActivityFeed.tsx`
- [ ] **Step 1:** `apps/api/src/lib/permissions.ts` (~line 136): change `reply.status(403).send({ error: 'Forbidden' })` to `return reply.status(403).send({ error: 'Forbidden' })`.
- [ ] **Step 2:** `(logs)/index.tsx` All-Activity fetch `catch` block: replace `void err;` with `if (__DEV__) console.warn('[logs] all-activity fetch failed', err);` — keep the existing user-facing `setServerError(...)` message.
- [ ] **Step 3:** `ActivityFeed.tsx`: the per-row `getPrimaryMedia('activity_log', r.id)` currently runs inside each row's render. Replace with a single pass computed when `entries` changes — `const mediaByRow = useMemo(() => { const m: Record<string, MediaRecord> = {}; for (const r of entries) { const p = getPrimaryMedia('activity_log', r.id); if (p) m[r.id] = p; } return m; }, [entries]);` then each row reads `mediaByRow[r.id]` (falsy → no thumbnail). Lightbox still calls `getMediaForEntity` lazily on tap. Behavior identical, fewer queries per render.
- [ ] **Step 4 (controller): verify** `cd apps/mobile && npx tsc --noEmit` clean; `cd apps/api && npx tsc --noEmit` clean.
- [ ] **Step 5 (controller): commit** `fix(hardening): requirePermission return; logs dev-log on fetch error; ActivityFeed media memo`.

### Task 4: Shared constants + sync-migration checklist

**Files:** Create `apps/mobile/src/constants/locationStyles.ts`, `apps/mobile/src/constants/teams.ts`, `docs/SYNC-MIGRATION-CHECKLIST.md`; Modify `app/(app)/(locations)/index.tsx`, `app/(app)/(locations)/[id].tsx`, `app/(app)/(teams)/index.tsx`, `app/(app)/(teams)/[id].tsx`, `apps/mobile/AGENTS.md`
- [ ] **Step 1:** Read the existing `ICON_ALIASES`, `ICON_OPTIONS`, `COLOR_OPTIONS`, `renderIcon` in `(locations)/index.tsx`. Move them verbatim into `src/constants/locationStyles.ts` (export each). Import from there in `(locations)/index.tsx` AND `(locations)/[id].tsx`; delete the duplicated local copies in both. (If `[id].tsx`'s copy differs at all, the canonical version wins — note any diff.)
- [ ] **Step 2:** Read `TEAM_TYPES` in `(teams)/index.tsx`; move to `src/constants/teams.ts` (export); import in `(teams)/index.tsx` + `[id].tsx`; delete local copies + the prior `// keep in sync` comments.
- [ ] **Step 3:** Create `docs/SYNC-MIGRATION-CHECKLIST.md`:
```markdown
# Sync migration checklist
The sync layer uses HARDCODED column lists, not `SELECT *`. Any migration that adds a column to a
**synced** table MUST also update, in the same change:
1. `apps/api/src/routes/sync.ts` — push path (and `activity_log`'s explicit INSERT, which is fully hardcoded).
2. `apps/mobile/src/sync/pull.ts` — both `TABLE_UPSERT_SQL` (the INSERT OR REPLACE column list + placeholders)
   AND `rowToValues` (the matching value array). Column count must match placeholder count.
Skipping this silently drops the new column on sync (push error or pull omission → data loss / never propagates).
Burned us on migration 008 (jobs work-order fields) and 009 (location coords). Verify column/placeholder parity.
```
- [ ] **Step 4:** Add one line to `apps/mobile/AGENTS.md` pointing at the checklist (e.g. under a "Sync" note: "When a migration adds a synced column, follow `docs/SYNC-MIGRATION-CHECKLIST.md`.").
- [ ] **Step 5 (controller): verify** `npx tsc --noEmit` clean.
- [ ] **Step 6 (controller): commit** `refactor: extract shared location/team constants + add sync-migration checklist`.

# WAVE 1 (after T1)

### Task 2: Settings screen content + Idle auto-logout

**Files:** Create `apps/mobile/src/hooks/useIdleLogout.ts`; Modify `app/(app)/(admin)/settings.tsx`, `app/(app)/_layout.tsx`
**Consumes:** Task 1's `syncNow()`.

- [ ] **Step 1: idle helper queries.** In `settings.tsx` (or a tiny inline helper), read/write the idle pref via `app_settings`: `getDb().executeSync("INSERT OR REPLACE INTO app_settings (key,value) VALUES ('idle_timeout_minutes', ?)", [String(mins)])` and read with `SELECT value ... WHERE key='idle_timeout_minutes'` (parse int, default 0=Off).
- [ ] **Step 2: `useIdleLogout.ts`.** Hook: reads `idle_timeout_minutes` from `app_settings` (re-read on mount + when told); if `>0`, maintains a `setTimeout(logout, mins*60000)` that resets on `reset()` and on `AppState` →`active`; clears on unmount / when pref is 0. `logout` = the passed `clearSession()`-based callback. Returns `{ reset: () => void }`. No-op when pref is 0.
- [ ] **Step 3: wire into `(app)/_layout.tsx`.** Call `useIdleLogout(...)`; wrap the authed `Stack` in a `View style={{flex:1}}` with `onStartShouldSetResponderCapture={() => { reset(); return false; }}` (resets on every touch without stealing gestures). When the timer fires it calls logout (`clearSession()` via the session context) → the existing `!user` guard redirects to `/(auth)/login`.
- [ ] **Step 4: Settings sections** in `settings.tsx`:
  - **Account:** card with `user.name` + `ROLE_DISPLAY_NAMES[user.role]`; **"Log out"** button → the session context logout (same one the header switch-user button calls).
  - **Sync:** **"Sync now"** → `await syncNow()` then refresh the status line; show last-sync (`app_settings.last_pulled_at` → `new Date(v).toLocaleString()`, or "never") + pending count (`SELECT COUNT(*) FROM outbox WHERE synced_at IS NULL`).
  - **App info:** `Constants.expoConfig?.version ?? '1.0.0'` (`import Constants from 'expo-constants'`), `process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'`, signed-in user id + role.
  - **Idle auto-logout:** a selector (Off / 5 / 15 / 30 min) writing `idle_timeout_minutes` (Step 1). Keep the existing gated Developer-tools → Quick Add row.
- [ ] **Step 5 (controller): verify** `npx tsc --noEmit` clean; manual per the spec's Verification.
- [ ] **Step 6 (controller): commit** `feat(settings): account/logout, sync-now+status, app info, idle auto-logout`.

---

# SHIP (controller, after all tasks merge)
- [ ] App-wide `npx tsc --noEmit` (mobile + api) clean; whole-branch review (opus).
- [ ] Merge `feat/settings-core` → `main`. **No prod redeploy / no dev-client rebuild** (the api `return` change is a one-liner that DOES go to prod with the next API image — fold into the next deploy, or redeploy now since it's harmless). JS reaches the dev client via Metro reload; rebuild the **release APK**.

## Self-Review (controller checklist)
- **Spec coverage:** U1→T2 step4; U2→T2 steps1-3; U3→T1 step1; U4→T1 step2 + T3; U5→T4. ✔
- **Placeholder scan:** all code literal; the idle hook + settings queries are concrete.
- **Type consistency:** `syncNow` (T1) consumed by T2; `useIdleLogout` returns `{reset}` (T2 step2/3 consistent); `mediaByRow` memo type matches `getPrimaryMedia` return (T3).
- **File-collision check:** T1 = engine.ts; T2 = settings.tsx + useIdleLogout.ts + (app)/_layout.tsx; T3 = api/permissions.ts + (logs)/index.tsx + ActivityFeed.tsx; T4 = constants + (locations)/(teams) + docs. All disjoint. T1+T3+T4 parallel; T2 after T1. ✔
- **Note:** the api `return reply` change means the next prod API image carries it; behavior identical, so deploy timing is flexible.
