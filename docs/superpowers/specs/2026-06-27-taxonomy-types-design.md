# Configurable Taxonomies — Foundation + Team & Job Types (P1 phase 1) — Design Spec

*Date: 2026-06-27 · Branch: `feat/taxonomy-types` · Roadmap P1, first decomposed chunk.*

## Context

Type lists are hardcoded today (`TEAM_TYPES` constant; jobs have no type at all). P1 makes them
**admin-managed, synced, runtime-editable** so new types can be added without a rebuild. This first chunk
builds the shared **taxonomy foundation** and wires the two flat icon+label taxonomies — **Team types** and
**Job types**. The heavier item **kind → allowed-units** evolution and **conditional-Owner** rule are
deferred to later P1 specs (they need data-model surgery / conditional UI).

### Autonomous decisions (assumptions — adjust freely)
The user delegated this ("proceed"). Decisions made + flagged:
- **One synced table** `taxonomy_types(id, category, label, icon, sort_order, active, updated_at)` holds all
  flat taxonomies; `category` ∈ `'team' | 'job'` (extensible). Reused for future taxonomies.
- **Entities store the chosen label string** (denormalized), not a FK id: `teams.type` already is a label;
  `jobs` gets a new `type` TEXT column. The taxonomy table is the editable **option list + icons**; an
  entity's icon is looked up by `(category, label)`. *Caveat (v1):* renaming a type's label orphans existing
  entities holding the old label (they show the raw old label, no icon) — acceptable for v1; an id-FK
  migration is a future hardening.
- **Seed on migration:** the existing `TEAM_TYPES` values become initial `category='team'` rows (nothing
  breaks); seed sensible `category='job'` rows with icons (Fire damage 🔥, Water damage 💧, Mold 🦠,
  Cleaning 🧽, Construction 🛠️, Carpet 🧶, Moving 📦, Other 🗂️).
- **Admin-gated** on the existing tier-4 `system_settings` permission (same gate as maintenance/form-mode).

## Global Constraints
- Expo SDK 56; op-sqlite binds `string|number|null|ArrayBuffer`. **No native deps** (RN only).
- **Migration 011** adds a SYNCED table + a synced column → MUST follow `docs/SYNC-MIGRATION-CHECKLIST.md`:
  update `apps/api/src/routes/sync.ts` (`ALLOWED_TABLES`, `FULL_TABLES`, `CONFLICT_TARGETS`) AND
  `apps/mobile/src/sync/pull.ts` (`TABLE_UPSERT_SQL` + `rowToValues`) for `taxonomy_types`, **and** add
  `jobs.type` to pull.ts's hardcoded `jobs` column list + `rowToValues` (the 008-class trap).
- No new permission. Admin setter writes locally + `appendOutbox('INSERT','taxonomy_types',…)` to sync.
- TypeScript gate: `npx tsc --noEmit` clean (mobile + api).

## Shared Context Pack
- **Existing:** `src/constants/teams.ts` `TEAM_TYPES = ['operations','management','construction','contents','cleaning','admin','other']`. `(teams)/index.tsx` imports it, `type` state defaults `TEAM_TYPES[0]`, stores `teams.type` (label), renders `team.type`. Server `teams`: id,name,type,manager_id,updated_at. Server `jobs`: id,name,status,created_by,created_at,updated_at,job_number,customer_name,site_address,site_location_id,description (**no type**).
- **Icon picker reuse:** `src/constants/locationStyles.ts` `ICON_OPTIONS` (12 emoji), `renderIcon(icon)`, `ICON_ALIASES`. Extend `ICON_OPTIONS` (or add a `TYPE_ICON_OPTIONS`) to include 🔥💧🦠🧽🛠️🧶📦🗂️ for job/team types.
- **Migration pattern:** `010_app_config.{sql,ts}` + `schema.ts loadMigrations()` registration; `apps/api/src/db/migrations/010_app_config.sql` (auto-run on boot). `app_config` sync wiring in sync.ts/pull.ts is the reference for adding `taxonomy_types`.
- **Admin Settings:** `(admin)/settings.tsx` tier-4 sections (`usePermission('system_settings')`); routing to a new admin screen mirrors `(admin)/users.tsx`/`roles.tsx`.
- **Synced config setter pattern:** `src/db/maintenance.ts setMaintenanceMode` (local write + appendOutbox INSERT) — mirror for taxonomy CRUD.

---

## Architecture (5 units)

### Unit 1 — Migration 011 (taxonomy_types + jobs.type) + sync wiring
- **Postgres** `apps/api/src/db/migrations/011_taxonomy_types.sql`:
  ```sql
  CREATE TABLE IF NOT EXISTS taxonomy_types (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category TEXT NOT NULL, label TEXT NOT NULL, icon TEXT,
    sort_order INT NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS type TEXT;
  -- seed team types (from TEAM_TYPES) + job types (with icons); idempotent via NOT EXISTS on (category,label)
  ```
  (Seed each row only if not already present for that category+label.)
- **SQLite** `migrations/011_taxonomy_types.ts` (version 11): same `taxonomy_types` table (TEXT id, INT sort_order, INTEGER active) + `ALTER TABLE jobs ADD COLUMN type TEXT`. Register in `schema.ts loadMigrations()`. (Local seeding is unnecessary — rows arrive via pull; but seed locally too so a fresh offline install has defaults, mirroring how role_settings/defaults are handled — optional, decide in plan.)
- **Sync wiring:** sync.ts — add `'taxonomy_types'` to `ALLOWED_TABLES` + `FULL_TABLES`; `CONFLICT_TARGETS['taxonomy_types']='id'`. pull.ts — add `taxonomy_types` to `TABLE_UPSERT_SQL` (6 cols: id,category,label,icon,sort_order,active,updated_at → 7) + `rowToValues`; **and add `type` to the existing `jobs` `TABLE_UPSERT_SQL` + `rowToValues`** (append `row.type ?? null`). Verify column/placeholder parity.

### Unit 2 — Taxonomy queries (`src/db/queries/taxonomy.ts`)
- `getTaxonomyTypes(category: string, opts?: { includeInactive?: boolean }): TaxonomyType[]` — `SELECT * FROM taxonomy_types WHERE category=? [AND active=1] ORDER BY sort_order, label`.
- `getTypeIcon(category: string, label: string): string | null` — lookup for display.
- Admin mutations (local write + outbox INSERT, like setMaintenanceMode): `addTaxonomyType({category,label,icon})`, `renameTaxonomyType(id,label)`, `setTaxonomyIcon(id,icon)`, `setTaxonomyActive(id,active)`, `reorderTaxonomyType(id,sort_order)`. Each `INSERT OR REPLACE` locally + `appendOutbox('INSERT','taxonomy_types', {full row})`. `type TaxonomyType = { id; category; label; icon: string|null; sort_order: number; active: number; updated_at: string }`.

### Unit 3 — Admin "Manage Types" screen (`app/(app)/(admin)/manage-types.tsx`)
- Tier-4 gated (route guarded like other admin screens). Two sections (Team Types, Job Types). Each: a list of that category's types (icon + label), with add (label + icon picker), rename, set-icon, archive (active=0), reorder. Uses the Unit-2 mutations, `renderIcon`, and `ModalSheet`/primitives. Add a "⚙ Manage Types" row to `(admin)/settings.tsx` (tier-4 section) routing here.

### Unit 4 — Teams read taxonomy
- `(teams)/index.tsx` (and `[id].tsx` if it edits type): replace `import { TEAM_TYPES }` + the `TEAM_TYPES.map` picker with `getTaxonomyTypes('team')` (labels + icons). Default `type` to the first active team type (guard empty). Display the team's type with its icon via `getTypeIcon('team', team.type)`. `teams.type` still stores the label. (Leave `src/constants/teams.ts` in place as a fallback seed source; do not delete.)

### Unit 5 — Jobs gain a type
- `(jobs)/create.tsx` (+ `[id].tsx` edit): add a **Type** picker reading `getTaxonomyTypes('job')` (icon+label); store the chosen label in the new `jobs.type`. Include `type` in the job outbox payload (jobs/create already builds an explicit payload — add `type: <label> ?? null`; remember the synced_at-strip rule already in place). Show the job's type+icon on the job detail/list (via `getTypeIcon('job', job.type)`). Put the Type field in the form's `<AdvancedFields>` group only if Simple-mode hiding is desired — default: keep Type visible (it's a primary attribute).

---

## File map
| Unit | Files |
|---|---|
| 1 | `apps/api/src/db/migrations/011_taxonomy_types.sql` (new), `apps/mobile/src/db/migrations/011_taxonomy_types.ts` (new), `apps/mobile/src/db/schema.ts`, `apps/api/src/routes/sync.ts`, `apps/mobile/src/sync/pull.ts` |
| 2 | `apps/mobile/src/db/queries/taxonomy.ts` (new) |
| 3 | `apps/mobile/app/(app)/(admin)/manage-types.tsx` (new), `app/(app)/(admin)/settings.tsx` (link) |
| 4 | `apps/mobile/app/(app)/(teams)/index.tsx` (+ `[id].tsx`), `src/constants/locationStyles.ts` (extend icon set) |
| 5 | `apps/mobile/app/(app)/(jobs)/create.tsx`, `app/(app)/(jobs)/[id].tsx`, `app/(app)/(jobs)/index.tsx` (display) |

## Verification
- `tsc --noEmit` clean (mobile + api). Migration 011 applies on prod boot (`schema_migrations` has 011; `taxonomy_types` exists; `jobs.type` exists) and on device (schema_version=11). pull.ts column/placeholder parity (taxonomy_types 7/7; jobs +1).
- Admin (tier-4) → Settings → Manage Types: add a job type "Biohazard" with an icon → it appears in the job-create Type picker on this device and (after sync) on another device.
- Teams create: type picker shows the synced team types (seeded from TEAM_TYPES) with icons; a newly-added team type appears.
- Jobs create: pick a type → saved on the job → shown with icon on the job list/detail → syncs.
- Non-admins do not see Manage Types but DO see the synced types in the pickers.

## Out of scope (later P1 specs)
- Item **kind → allowed-units** taxonomy + unit-picker-by-kind (data-model evolution of `kind`/`unit_category`/`category`).
- **Conditional Owner** field + admin parent-location rule.
- Migrating entity `type` from label to FK id (rename-propagation hardening).
- Reordering UX polish / drag-and-drop (v1 uses up/down or a sort_order field edit).
