# Settings Core + Hardening — Design Spec

*Date: 2026-06-26 · Branch: `feat/settings-core` · Program Phase 3a of 4 (3a/3b/3c)*

## Context

The Settings screen (built as a host in Phase 1) gains real content, and the accumulated review-minor
hardening + a sync-migration checklist land here. Maintenance mode (3b) and Simple/Detailed form mode
(3c) are separate follow-on phases; this phase builds the screen they'll plug into and the self-contained
settings.

### Decisions locked with the user
Settings include: **Account (log out / switch user)**, **Idle auto-logout**, **Sync controls + status**,
**App/backend info**. Plus **hardening** (recorded review minors) and a **sync-migration checklist** doc.
No migration / no native (ships over Metro).

## Global Constraints

- Expo SDK 56 — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- op-sqlite bind params: only `string | number | null | ArrayBuffer`.
- Reuse existing infra; no new permission. Settings prefs persist in the existing local `app_settings`
  (key/value) table; clearing the session auto-redirects to login (`(app)/_layout.tsx` guard).
- No DB migration, no native module.

## Shared Context Pack

- **Session/logout** — `src/auth/session.ts` `clearSession(): Promise<void>`; `app/_layout.tsx` exposes the
  SessionContext (its logout method `await clearSession()` is what the header switch-user button uses);
  `(app)/_layout.tsx` redirects to `/(auth)/login` when `user` is null. `useSession()` → `{ user }`.
- **Sync** — `src/sync/engine.ts` (`startSyncEngine`/`stopSyncEngine`; the internal `syncCycle()` does
  drain+pull). `src/sync/outbox.ts` `getPendingOutbox(limit)`. `last_pulled_at` lives in `app_settings`
  (`SELECT value FROM app_settings WHERE key='last_pulled_at'`). `SyncIndicator` (header) already shows a dot + sheet.
- **app_settings** — local key/value table; read/write via `db.executeSync` (`INSERT OR REPLACE INTO app_settings (key,value) VALUES (?,?)`).
- **App info** — `app.json` `version` (1.0.0); `process.env.EXPO_PUBLIC_API_URL`.
- **Permission lib (api)** — `apps/api/src/lib/permissions.ts:136` `reply.status(403).send(...)` (missing `return`).
- **Recorded hardening minors** (from prior phase ledgers): `startSyncEngine` has no double-start guard
  (re-call leaks interval+listeners); `requirePermission` missing `return reply`; `(logs)/index.tsx`
  All-Activity fetch `catch { void err }` (no dev log); `ActivityFeed` calls `getPrimaryMedia` per row each
  render; ICON_ALIASES/ICON_OPTIONS/COLOR_OPTIONS duplicated in `(locations)/index.tsx`+`[id].tsx`; TEAM_TYPES
  duplicated in `(teams)/index.tsx`+`[id].tsx`.

---

## Architecture (5 units)

### Unit 1 — Settings screen content
`app/(app)/(admin)/settings.tsx`: extend the Phase-1 screen (keep the gated Developer-tools → Quick Add row). Add sections:
- **Account:** card showing `user.name` + role (`ROLE_DISPLAY_NAMES[user.role]`); a **"Log out"** button → the
  session context's logout (`clearSession()` via the context method the header uses) → auto-redirects to login.
- **Sync:** **"Sync now"** button → `syncNow()` (Unit 3); a line with **last sync** (`app_settings.last_pulled_at`,
  `toLocaleString`) and **pending to sync** = `getPendingOutbox(9999).length` (or a `COUNT(*)` on `outbox WHERE synced_at IS NULL`). Refresh these on focus + after a manual sync.
- **App info:** version via `expo-constants` (`Constants.expoConfig?.version ?? '1.0.0'`; `expo-constants` is a
  core Expo transitive dep — verify it resolves, and if it isn't already a dependency the implementer flags it
  rather than adding a native module in this JS-only phase, falling back to a `'1.0.0'` literal); backend URL
  (`process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:3000'`); signed-in user id/role.
- **Idle auto-logout:** a row to pick Off / 5 / 15 / 30 min (segmented or a simple selector), persisted to `app_settings` key `idle_timeout_minutes` (Unit 2 reads it).

### Unit 2 — Idle auto-logout enforcement
- `src/hooks/useIdleLogout.ts`: reads `idle_timeout_minutes` from `app_settings`; if >0, runs a timer that
  logs out (`clearSession()`) after that many minutes of inactivity. Inactivity = no touch + app foreground;
  resets on each touch and on AppState→active. Returns an `onTouch` handler (or use a PanResponder/`onStartShouldSetResponderCapture`).
- Wire into `app/(app)/_layout.tsx`: wrap the authed `Stack` in a `View` whose touch-capture resets the idle
  timer (e.g. `onStartShouldSetResponderCapture={() => { reset(); return false; }}`), and call the hook. When
  the timer fires, `clearSession()` → the existing `!user` guard redirects to login. Off (0) disables it. No-op
  when no session.

### Unit 3 — Manual sync trigger
`src/sync/engine.ts`: export `async function syncNow(): Promise<void>` that runs the existing `syncCycle()`
once (the same drain+pull). Settings "Sync now" awaits it then refreshes its status line.

### Unit 4 — Hardening (recorded minors)
- `engine.ts`: **double-start guard** — `startSyncEngine` returns early if already started (track a module
  `started` flag; `stopSyncEngine` resets it) so a second call can't leak the interval + NetInfo/AppState listeners.
- `apps/api/src/lib/permissions.ts:136`: `return reply.status(403).send({ error: 'Forbidden' })`.
- `app/(app)/(logs)/index.tsx`: in the All-Activity fetch catch, replace `void err` with `if (__DEV__) console.warn('[logs] fetch failed', err);` (keep the user-facing error message).
- `src/components/ActivityFeed.tsx`: memoize the per-row media lookup — compute a `Set`/map of which `r.id`s
  have primary media once per `entries` change (one pass) instead of calling `getPrimaryMedia` inside every
  render of every row. (Behavior identical; fewer queries.)

### Unit 5 — Shared constants + sync-migration checklist
- Extract `src/constants/locationStyles.ts` (`ICON_ALIASES`, `ICON_OPTIONS`, `COLOR_OPTIONS`, `renderIcon`) and
  `src/constants/teams.ts` (`TEAM_TYPES`); update `(locations)/index.tsx`+`[id].tsx` and `(teams)/index.tsx`+`[id].tsx`
  to import from them (delete the local copies). Behavior identical.
- New doc `docs/SYNC-MIGRATION-CHECKLIST.md`: a short checklist that any migration adding a **synced** column must
  also update `apps/api/src/routes/sync.ts` (push column handling) and `apps/mobile/src/sync/pull.ts`
  (`TABLE_UPSERT_SQL` + `rowToValues`) — the lesson from the location-aware + quick-add sync bugs. Reference it
  from the mobile `AGENTS.md` (one line).

---

## File map

| Unit | Files |
|---|---|
| 1 | `app/(app)/(admin)/settings.tsx` |
| 2 | `src/hooks/useIdleLogout.ts` (new), `app/(app)/_layout.tsx` |
| 3 | `src/sync/engine.ts` (also Unit 4's guard) |
| 4 | `src/sync/engine.ts`, `apps/api/src/lib/permissions.ts`, `app/(app)/(logs)/index.tsx`, `src/components/ActivityFeed.tsx` |
| 5 | `src/constants/locationStyles.ts` (new), `src/constants/teams.ts` (new), `(locations)/index.tsx`, `(locations)/[id].tsx`, `(teams)/index.tsx`, `(teams)/[id].tsx`, `docs/SYNC-MIGRATION-CHECKLIST.md` (new), `apps/mobile/AGENTS.md` |

## Verification
- `tsc --noEmit` clean (mobile + api).
- Manual: Settings shows account + log-out (returns to PIN login); "Sync now" drains outbox + updates last-sync/pending; app version + backend URL correct; set idle timeout to 5 min → after 5 min idle the app returns to login; Off disables it.
- Hardening: calling `startSyncEngine` twice doesn't double up timers (verify single interval); a tier-1 token still gets 403 on guarded routes (return doesn't change behavior, just hygiene); locations/teams screens render identically with shared constants.

## Out of scope (3b / 3c)
- Maintenance-mode toggle + synced flag + write-gating (Phase 3b).
- Simple/Detailed form-mode toggle + field-hiding across forms (Phase 3c).
- (Those rows get added to this Settings screen when their phases build the enforcement.)
