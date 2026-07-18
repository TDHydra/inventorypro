# Reactive Screens (#60/#61/#62) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every stale screen react to background sync pulls: Jobs list (#60), four mount-only screens (#61), and the seven focus-only screens (#62), replacing `useFocusRefresh` with a combined `useFocusOrDataRefresh`.

**Architecture:** The sync engine already broadcasts after every non-empty pull (`src/sync/pull.ts` → `bumpDataVersion()` in `src/sync/dataVersion.ts`). All fixes are subscription-side: key existing queries on `useDataVersion()` or on a new `useFocusOrDataRefresh()` (sum of the focus counter and `dataVersion` — both only increment, so the sum changes on either event). No sync-engine changes, no new store.

**Tech Stack:** React Native (Expo SDK 56, expo-router), `useSyncExternalStore` via the existing `useDataVersion` hook, op-sqlite synchronous queries.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-15-reactive-screens-design.md`.
- Working dir: `~/inventorypro`; all mobile paths below are relative to `apps/mobile/`.
- Branch: `feat/backlog-design-wave`. Commit after every task; end commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- `src/hooks/useFocusRefresh.ts` must be **deleted** by the end (Task 3) with zero remaining references.
- Out of scope: `useDbQuery` (#63), per-table granularity (#64), any `src/sync/` change.
- Verification gate per task: `cd apps/mobile && npx tsc --noEmit` → 0 errors. Full mobile test suite in Tasks 3 and 5: `npm test` → all pass (132 baseline).
- No new unit tests: the hook depends on expo-router's `useFocusEffect` (no renderer harness in repo); the store it composes is already covered. On-device verification is Task 6.

---

### Task 1: Create `useFocusOrDataRefresh`

**Files:**
- Create: `apps/mobile/src/hooks/useFocusOrDataRefresh.ts`

**Interfaces:**
- Consumes: `useDataVersion()` from `src/hooks/useDataVersion.ts` (returns `number`, bumps after sync pulls).
- Produces: `useFocusOrDataRefresh(): number` — the refresh key every later task imports.

- [ ] **Step 1: Write the hook**

```ts
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { useDataVersion } from './useDataVersion';

/**
 * THE refresh key for screens that read the local DB. Returns a counter that
 * changes when the screen regains focus OR when a background sync pull applies
 * changes (dataVersion bump) — so `useMemo`/`useEffect` keyed on it re-read the
 * DB both on refocus and live while the screen is open.
 *
 * Both inputs only ever increment, so their sum changes on either event.
 * Replaces the deleted focus-only useFocusRefresh, which left screens stale
 * until the user navigated away and back.
 *
 * Usage:
 *   const refreshKey = useFocusOrDataRefresh();
 *   const rows = useMemo(() => getRows(), [refreshKey]);
 */
export function useFocusOrDataRefresh(): number {
  const dataVersion = useDataVersion();
  const [focusKey, setFocusKey] = useState(0);
  // setState lives in the focus effect (not render), so no render loop. Fires
  // once on mount (initial focus) and again on every refocus.
  useFocusEffect(useCallback(() => { setFocusKey(k => k + 1); }, []));
  return focusKey + dataVersion;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd ~/inventorypro && git add apps/mobile/src/hooks/useFocusOrDataRefresh.ts \
  && git commit -m "feat(hooks): useFocusOrDataRefresh — refresh on focus OR sync pull (#62)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Migrate the 7 simple `useFocusRefresh` screens (#62)

**Files (Modify):**
- `apps/mobile/app/(app)/(inventory)/[id].tsx` (import at :15, call at :42)
- `apps/mobile/app/(app)/(jobs)/[id].tsx` (:18, :47)
- `apps/mobile/app/(app)/(locations)/[id].tsx` (:15, :48)
- `apps/mobile/app/(app)/(checkin)/index.tsx` (:25, :52)
- `apps/mobile/app/(app)/(checkout)/index.tsx` (:27, :63)
- `apps/mobile/app/(app)/(admin)/settings.tsx` (:8, :117)
- `apps/mobile/app/(app)/(admin)/broadcast.tsx` (:6, :50)

**Interfaces:**
- Consumes: `useFocusOrDataRefresh(): number` from Task 1.
- Produces: nothing new — each screen's existing `refreshKey` variable now also bumps on sync pulls; all dep arrays already keyed on `refreshKey` stay untouched.

- [ ] **Step 1: Swap import and call in all 7 files**

In each file, the two lines are identical in shape. Replace:

```ts
import { useFocusRefresh } from '../../../src/hooks/useFocusRefresh';
```

with:

```ts
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
```

and replace:

```ts
  const refreshKey = useFocusRefresh();
```

with:

```ts
  const refreshKey = useFocusOrDataRefresh();
```

Do NOT touch any dep array — they already key on `refreshKey`.

- [ ] **Step 2: Verify no stragglers among the 7 + typecheck**

Run: `cd ~/inventorypro/apps/mobile && grep -rn 'useFocusRefresh' app | grep -v equipment | grep -v 'inventory)/index'`
Expected: no output.
Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd ~/inventorypro && git add 'apps/mobile/app/(app)' \
  && git commit -m "fix(screens): detail/tool screens refresh on sync pull, not just refocus (#62)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Migrate equipment + inventory lists, delete `useFocusRefresh`

**Files:**
- Modify: `apps/mobile/app/(app)/(equipment)/index.tsx` (:19-20, :39-40, :140)
- Modify: `apps/mobile/app/(app)/(inventory)/index.tsx` (:21-22, :57-58)
- Delete: `apps/mobile/src/hooks/useFocusRefresh.ts`

**Interfaces:**
- Consumes: `useFocusOrDataRefresh(): number` from Task 1.
- Produces: repo-wide invariant — zero references to `useFocusRefresh` (Task 6 relies on the phone bundling only the new hook).

- [ ] **Step 1: Equipment list — swap hook, fold `dataVersion` into `refreshKey`**

`(equipment)/index.tsx` uses `refreshKey` in two dep arrays (:63, :67) and a separate `dataVersion` only at :140 (`}, [load, dataVersion])`, inside a `useFocusEffect` whose callback re-runs `load()`. A focus effect re-fires on every focus regardless of deps, so keying it on `refreshKey` (focus + data) is equivalent to `dataVersion` there. Replace:

```ts
import { useFocusRefresh } from '../../../src/hooks/useFocusRefresh';
import { useDataVersion } from '../../../src/hooks/useDataVersion';
```

with:

```ts
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
```

Replace (:39-40):

```ts
  const refreshKey = useFocusRefresh();
  const dataVersion = useDataVersion();
```

with:

```ts
  const refreshKey = useFocusOrDataRefresh();
```

Replace the dep array at :140:

```ts
    }, [load, dataVersion]),
```

with:

```ts
    }, [load, refreshKey]),
```

- [ ] **Step 2: Inventory list — swap hook, KEEP its `useDataVersion`**

`(inventory)/index.tsx` has a paged-list effect at :101-116 **deliberately keyed only on `dataVersion`** (its comment explains focus/query churn must not truncate the list). Keep that import, that variable, and that effect untouched. Only swap the focus hook. Replace (:21):

```ts
import { useFocusRefresh } from '../../../src/hooks/useFocusRefresh';
```

with:

```ts
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
```

Replace (:57):

```ts
  const refreshKey = useFocusRefresh();
```

with:

```ts
  const refreshKey = useFocusOrDataRefresh();
```

Line :58 (`const dataVersion = useDataVersion();`), the import at :22, and the effect at :101-116 stay exactly as they are.

- [ ] **Step 3: Delete the old hook and prove zero references**

```bash
cd ~/inventorypro && rm apps/mobile/src/hooks/useFocusRefresh.ts
grep -rn 'useFocusRefresh' apps/mobile/app apps/mobile/src || echo CLEAN
```

Expected: `CLEAN` (note `useFocusOrDataRefresh` does not contain the exact string `useFocusRefresh` — the grep is a true zero-reference check).

- [ ] **Step 4: Typecheck + full mobile test suite**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit && npm test`
Expected: 0 errors; all tests pass (132 baseline).

- [ ] **Step 5: Commit**

```bash
cd ~/inventorypro && git add -A apps/mobile \
  && git commit -m "refactor(hooks): delete focus-only useFocusRefresh; all screens on useFocusOrDataRefresh (#62)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Jobs list reacts to sync (#60)

**Files:**
- Modify: `apps/mobile/app/(app)/(jobs)/index.tsx` (imports at :1 area, dep arrays at :66, :76, :79)

**Interfaces:**
- Consumes: `useDataVersion()` from `src/hooks/useDataVersion.ts`.
- Produces: nothing consumed later; keeps `reloadKey` (local mutations still bump it for instant feedback).

- [ ] **Step 1: Subscribe and key the three DB reads**

Add the import (the file currently imports no hook from `src/hooks` for refresh):

```ts
import { useDataVersion } from '../../../src/hooks/useDataVersion';
```

Inside `JobsScreen()`, next to `const [reloadKey, setReloadKey] = useState(0);` (:51), add:

```ts
  // Re-run the DB reads below when a background sync pull applies changes, so a
  // job/type created on another device appears while this screen is open (#60).
  const dataVersion = useDataVersion();
```

Change the `myCheckouts` dep array (:66):

```ts
  }, [user, reloadKey]);
```

to:

```ts
  }, [user, reloadKey, dataVersion]);
```

Change the `allJobs` dep array (:76):

```ts
  }, [search, statusFilter, showArchived, reloadKey]);
```

to:

```ts
  }, [search, statusFilter, showArchived, reloadKey, dataVersion]);
```

Change `jobTypes` (:79):

```ts
  const jobTypes = useMemo(() => getTaxonomyTypesWithFallback('job'), []);
```

to:

```ts
  const jobTypes = useMemo(() => getTaxonomyTypesWithFallback('job'), [dataVersion]);
```

- [ ] **Step 2: Typecheck**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd ~/inventorypro && git add 'apps/mobile/app/(app)/(jobs)/index.tsx' \
  && git commit -m "fix(jobs): list, checkouts and type picker refresh on sync pull (#60)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Mount-only screens react to sync (#61)

**Files:**
- Modify: `apps/mobile/app/(app)/(dashboard)/index.tsx` (:10 import, :37 memo)
- Modify: `apps/mobile/app/(app)/(admin)/users.tsx` (:1 import, after :170)
- Modify: `apps/mobile/app/(app)/(admin)/manage-types.tsx` (:1 import, after :354)
- Modify: `apps/mobile/app/(app)/(teams)/[id].tsx` (:1/:5 imports, :54-59 focus effect)

**Interfaces:**
- Consumes: `useDataVersion()` (dashboard, users, manage-types); `useFocusOrDataRefresh()` from Task 1 (team detail).
- Produces: nothing consumed later.

- [ ] **Step 1: Dashboard low-stock**

`(dashboard)/index.tsx`. Add import:

```ts
import { useDataVersion } from '../../../src/hooks/useDataVersion';
```

Inside `DashboardScreen()`, replace (:37):

```ts
  const all = useMemo(() => getLowStockItems(), []);
```

with:

```ts
  // Keyed on dataVersion so the low-stock widget updates live after a sync pull
  // (the layout is already reactive via useDashboardLayout; the DATA wasn't) (#61).
  const dataVersion = useDataVersion();
  const all = useMemo(() => getLowStockItems(), [dataVersion]);
```

- [ ] **Step 2: Admin users**

`(admin)/users.tsx`. Extend the react import (:1) to include `useEffect`:

```ts
import { useState, useMemo, useEffect } from 'react';
```

Add import:

```ts
import { useDataVersion } from '../../../src/hooks/useDataVersion';
```

Inside `AdminUsersScreen()`, directly under `const [users, setUsers] = useState<User[]>(() => getAllUsers());` (:170), add:

```ts
  // Re-read on sync pull so a user added/edited on another device shows while
  // this screen is open. The edit sheet holds its own editUser object, so a
  // background re-read can't clobber an in-progress edit (#61).
  const dataVersion = useDataVersion();
  useEffect(() => { setUsers(getAllUsers()); }, [dataVersion]);
```

- [ ] **Step 3: Manage types (with drag guard)**

`(admin)/manage-types.tsx`. Extend the react import (:1):

```ts
import { useEffect, useMemo, useRef, useState } from 'react';
```

Add import:

```ts
import { useDataVersion } from '../../../src/hooks/useDataVersion';
```

Directly under the last taxonomy state (`equipmentTypes`, ends :354), add:

```ts
  // Re-read all seven lists on sync pull so a taxonomy value created on another
  // device appears while this screen is open. Skipped mid-drag so a pull can't
  // yank rows out from under the gesture; deps include `dragging`, so the
  // re-read catches up as soon as the drag ends (#61).
  const dataVersion = useDataVersion();
  useEffect(() => {
    if (dragging) return;
    setTeamTypes(getTaxonomyTypes('team', { includeInactive: true }));
    setJobTypes(getTaxonomyTypes('job', { includeInactive: true }));
    setClassTypes(getTaxonomyTypes('product_class', { includeInactive: true }));
    setItemCatTypes(getTaxonomyTypes('item_category', { includeInactive: true }));
    setLocTypes(getTaxonomyTypes('location_type', { includeInactive: true }));
    setLocSubtypes(getTaxonomyTypes('location_subtype', { includeInactive: true }));
    setRepairStatuses(getTaxonomyTypes('repair_status', { includeInactive: true }));
    setEquipmentTypes(getTaxonomyTypes('equipment', { includeInactive: true }));
  }, [dataVersion, dragging]);
```

(Eight setters — `repairStatuses` and `equipmentTypes` both exist; the issue said "seven" but the file has eight taxonomy lists. Match the actual `useState` initializers present in the file, calling each setter with the exact same `getTaxonomyTypes(category, { includeInactive: true })` arguments as its initializer.)

- [ ] **Step 4: Team detail**

`(teams)/[id].tsx`. Replace the focus-only re-read (:54-59):

```ts
  useFocusEffect(
    useCallback(() => {
      setTeam(getTeamById(id));
      setMembers(getTeamMembers(id));
    }, [id]),
  );
```

with:

```ts
  const refreshKey = useFocusOrDataRefresh();
  useEffect(() => {
    setTeam(getTeamById(id));
    setMembers(getTeamMembers(id));
  }, [id, refreshKey]);
```

Add imports: `useEffect` joins the react import (:1); add:

```ts
import { useFocusOrDataRefresh } from '../../../src/hooks/useFocusOrDataRefresh';
```

Then remove `useFocusEffect` from the expo-router import (:5) and `useCallback` from the react import **only if** `grep -n 'useFocusEffect\|useCallback' 'app/(app)/(teams)/[id].tsx'` shows no remaining uses; keep them if used elsewhere in the file. Also update the two comments that say "re-read on focus" (:51-53 and the `myMembership` note at :62-64) to say "on focus or sync pull".

- [ ] **Step 5: Typecheck + full mobile test suite**

Run: `cd ~/inventorypro/apps/mobile && npx tsc --noEmit && npm test`
Expected: 0 errors; all tests pass.

- [ ] **Step 6: Commit**

```bash
cd ~/inventorypro && git add 'apps/mobile/app/(app)' \
  && git commit -m "fix(screens): dashboard low-stock, admin users, manage-types, team detail react to sync (#61)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Hotload + live cross-device verification + push + board

**Files:** none (verification, deploy-side only).

**Interfaces:**
- Consumes: all prior tasks bundled by Metro; prod Postgres access via `ssh root@192.168.1.239 "docker exec inventorypro-postgres-1 psql -U inventorypro -d inventorypro …"`.
- Produces: verified screens; branch pushed; board comment/columns updated.

- [ ] **Step 1: Hotload the dev client** (deploy-android §B rules: free port 8081 by port, no CI=1, `--clear`, `EXPO_PUBLIC_API_URL=https://api.invenpro.app` as a shell var, `adb reverse tcp:8081 tcp:8081`, launch via `exp+inventorypro://` deep link). Confirm `ReactNativeJS: Running "main"` and no red-box, and that the served bundle contains `useFocusOrDataRefresh`:

```bash
curl -s 'http://localhost:8081/.expo/.virtual-metro-entry.bundle?platform=android&dev=true' | grep -c useFocusOrDataRefresh
```

Expected: ≥ 1.

- [ ] **Step 2: #60 live proof — Jobs list.** With the phone sitting on the Jobs list (screenshot first; do NOT blind-tap), insert a test job on prod as if from another device, then wait for the next pull (60s heartbeat — or foreground-toggle the app to force one) and screenshot again:

```bash
ssh root@192.168.1.239 "docker exec inventorypro-postgres-1 psql -U inventorypro -d inventorypro -c \
  \"INSERT INTO jobs (id, name, status, created_at, updated_at) VALUES (gen_random_uuid(), 'REACTIVE-TEST-60', 'open', NOW(), NOW());\""
```

Expected: `REACTIVE-TEST-60` appears on the open list without any navigation. (Check the jobs table's NOT NULL columns first with `\d jobs` and extend the INSERT if more are required — e.g. `job_number` has a sequence/default; supply whatever lacks a default.)

- [ ] **Step 3: #62 live proof — job detail.** Open the `REACTIVE-TEST-60` job's detail screen (verified-coordinate taps only), then:

```bash
ssh root@192.168.1.239 "docker exec inventorypro-postgres-1 psql -U inventorypro -d inventorypro -c \
  \"UPDATE jobs SET name = 'REACTIVE-TEST-60-RENAMED', updated_at = NOW() WHERE name = 'REACTIVE-TEST-60';\""
```

Expected: the open detail screen shows the new name after the next pull, without leaving the screen.

- [ ] **Step 4: #61 live proof — manage-types.** With Settings → Manage Types open on the phone:

```bash
ssh root@192.168.1.239 "docker exec inventorypro-postgres-1 psql -U inventorypro -d inventorypro -c \
  \"INSERT INTO taxonomy_types (id, category, label, sort_order, active, created_at, updated_at) VALUES (gen_random_uuid(), 'job', 'REACTIVE-TEST-61', 999, TRUE, NOW(), NOW());\""
```

Expected: `REACTIVE-TEST-61` appears in the Job Types section while the screen is open. (Same caveat: check `\d taxonomy_types` for required columns before inserting.)

- [ ] **Step 5: Clean up prod test rows**

```bash
ssh root@192.168.1.239 "docker exec inventorypro-postgres-1 psql -U inventorypro -d inventorypro -c \
  \"DELETE FROM jobs WHERE name LIKE 'REACTIVE-TEST-60%'; DELETE FROM taxonomy_types WHERE label = 'REACTIVE-TEST-61';\""
```

Expected: `DELETE 1` twice. Note: the phone will drop the rows on its next pull only if the server sync uses soft-deletes for these tables — if the rows linger locally, that's the known hard-delete propagation limitation (same as the 1264-items case); note it and move on, do not chase it.

- [ ] **Step 6: Push + board**

```bash
cd ~/inventorypro && git push origin feat/backlog-design-wave
python3 .claude/skills/board/scripts/gh_move.py 60 'In review'
python3 .claude/skills/board/scripts/gh_move.py 61 'In review'
python3 .claude/skills/board/scripts/gh_move.py 62 'In review'
```

(Check `gh_move.py --help` / `references/board.md` for exact argument syntax before running; the board scripts are the only allowed mutation path.)
