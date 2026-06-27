# Taxonomy Foundation + Team & Job Types (P1 phase 1) — Implementation Plan

> Ultramode/SDD. Gate per task: `npx tsc --noEmit` clean (mobile + api). Implementers do NO git/tsc; controller commits + tsc + reviews.

**Goal:** Synced, admin-editable Team & Job type lists (icon + label) the forms read from, replacing the hardcoded `TEAM_TYPES`.
**Architecture:** One synced `taxonomy_types` table (migration 011) + a `jobs.type` column; `taxonomy.ts` queries (read + admin CRUD via outbox); an admin "Manage Types" screen; teams/jobs pickers read from the table. No native deps.
**Tech Stack:** Fastify+Postgres; Expo SDK 56 + op-sqlite.

## Global Constraints
- op-sqlite binds `string|number|null|ArrayBuffer`. No native deps, no new permission (admin = tier-4 `system_settings`).
- **Migration 011 (sync-migration checklist!):** synced `taxonomy_types` (7 cols: id, category, label, icon, sort_order, active, updated_at) + `jobs.type`. Update sync.ts (ALLOWED_TABLES, FULL_TABLES, CONFLICT_TARGETS['taxonomy_types']='id') AND pull.ts (TABLE_UPSERT_SQL + rowToValues for taxonomy_types **7/7**, AND append `type` to the existing jobs SQL + rowToValues).
- Entities store the chosen **label** (denormalized); `teams.type` exists, `jobs.type` is new. Admin mutations: local write + `appendOutbox('INSERT','taxonomy_types',{full row})` (mirror `setMaintenanceMode`).
- **Full spec (exact schema/decisions): `docs/superpowers/specs/2026-06-27-taxonomy-types-design.md`** — ships with every brief.

---

# WAVE 0 — Foundation (parallel, disjoint)

### Task A: Migration 011 + sync wiring + icon set
**Files:** Create `apps/api/src/db/migrations/011_taxonomy_types.sql`, `apps/mobile/src/db/migrations/011_taxonomy_types.ts`; Modify `apps/mobile/src/db/schema.ts` (register m011), `apps/api/src/routes/sync.ts`, `apps/mobile/src/sync/pull.ts`, `apps/mobile/src/constants/locationStyles.ts`.
- [ ] PG migration: `CREATE TABLE taxonomy_types(...)` + `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS type TEXT` + idempotent seed (team types from TEAM_TYPES = operations/management/construction/contents/cleaning/admin/other; job types Fire damage🔥/Water damage💧/Mold🦠/Cleaning🧽/Construction🛠️/Carpet🧶/Moving📦/Other🗂️ — seed each only if NOT EXISTS for that category+label). SQLite m011 (version 11): same table (TEXT id, INTEGER active/sort_order) + `ALTER TABLE jobs ADD COLUMN type TEXT`; register in schema.ts loadMigrations (import m011, push, keep sort).
- [ ] sync.ts: `taxonomy_types` → ALLOWED_TABLES + FULL_TABLES; CONFLICT_TARGETS['taxonomy_types']='id'. pull.ts: `taxonomy_types` TABLE_UPSERT_SQL (7 placeholders) + rowToValues `[id,category,label,icon??null,sort_order,active?1:0,updated_at]`; AND append `type` to the jobs TABLE_UPSERT_SQL column list + a `, row.type ?? null` to the jobs rowToValues (count/placeholder parity).
- [ ] locationStyles.ts: extend `ICON_OPTIONS` to include 🔥💧🦠🧽🛠️🧶📦🗂️ (for type icons) — additive, keep existing.
- [ ] Controller: api+mobile tsc clean; commit `feat(taxonomy): migration 011 + sync wiring + type icons`.

### Task B: Taxonomy queries
**Files:** Create `apps/mobile/src/db/queries/taxonomy.ts`.
**Produces:** `type TaxonomyType={id;category;label;icon:string|null;sort_order:number;active:number;updated_at:string}`; `getTaxonomyTypes(category:string, opts?:{includeInactive?:boolean}):TaxonomyType[]`; `getTypeIcon(category:string,label:string):string|null`; `addTaxonomyType({category,label,icon})`, `renameTaxonomyType(id,label)`, `setTaxonomyIcon(id,icon)`, `setTaxonomyActive(id,active:boolean)`, `reorderTaxonomyType(id,sort_order)`.
- [ ] Read fns: `SELECT * FROM taxonomy_types WHERE category=? [AND active=1] ORDER BY sort_order, label`. Mutations: generate uuid for add; `INSERT OR REPLACE INTO taxonomy_types(...)` locally (updated_at=now) + `appendOutbox('INSERT','taxonomy_types',{id,category,label,icon,sort_order,active(real bool in payload),updated_at})` (mirror setMaintenanceMode; strip nothing — taxonomy_types has no local-only cols). Use getDb()/rowsAs/generateUUID.
- [ ] Controller: mobile tsc clean; commit `feat(taxonomy): taxonomy_types queries + admin CRUD`.

# WAVE 1 — Wire (parallel after Wave 0; consume Task B)

### Task C: Admin "Manage Types" screen
**Files:** Create `apps/mobile/app/(app)/(admin)/manage-types.tsx`; Modify `app/(app)/(admin)/settings.tsx` (tier-4 "⚙ Manage Types" row → router.push to it).
- [ ] Screen (mirror users.tsx/roles.tsx structure + guard): Team Types + Job Types sections; each lists category rows (renderIcon+label) with add (label + icon picker from ICON_OPTIONS), rename, set-icon, archive (setTaxonomyActive false), and up/down reorder (reorderTaxonomyType). Uses Task-B mutations + ModalSheet/primitives/theme. settings.tsx: add the gated row.
- [ ] Controller: mobile tsc clean; commit `feat(admin): Manage Types screen`.

### Task D: Teams read taxonomy
**Files:** Modify `app/(app)/(teams)/index.tsx`, `app/(app)/(teams)/[id].tsx`.
- [ ] Replace `import { TEAM_TYPES }` + the `TEAM_TYPES.map` picker with `getTaxonomyTypes('team')` (FilterChips: renderIcon(icon)+label; value=label). Default `type` to the first active team type (guard empty array → ''). Render a team's type with its icon via `getTypeIcon('team', team.type)`. Keep storing `teams.type` = label. Do NOT delete src/constants/teams.ts.
- [ ] Controller: mobile tsc clean; commit `feat(teams): type picker from taxonomy`.

### Task E: Jobs gain a type
**Files:** Modify `app/(app)/(jobs)/create.tsx`, `app/(app)/(jobs)/[id].tsx`, `app/(app)/(jobs)/index.tsx`.
- [ ] create.tsx: add a **Type** picker (`getTaxonomyTypes('job')`, FilterChips icon+label) storing the chosen label; include `type: <label> || null` in the explicit jobs outbox payload (keep the existing synced_at-strip; jobs/create already builds an explicit payload). [id].tsx: allow editing type (UPDATE jobs.type + outbox). index.tsx + [id].tsx: display the job's type with `getTypeIcon('job', job.type)`. Keep Type visible (primary attribute; don't hide behind AdvancedFields).
- [ ] Controller: mobile tsc clean; commit `feat(jobs): job type from taxonomy`.

# SHIP (controller)
- [ ] App-wide tsc (mobile+api). Whole-branch review (opus). Merge `feat/taxonomy-types` → `main`.
- [ ] **Deploy migration 011 to prod** (auto-runs on boot; additive). Verify `taxonomy_types` + `jobs.type` exist + seed rows present. JS reaches dev client via Metro (no native dep). Manual: Manage Types add/rename/archive → picker updates → syncs to a 2nd device.

## Self-Review
- Spec coverage: U1→A; U2→B; U3→C; U4→D; U5→E. ✔
- File-collision: A (migrations/schema/sync/pull/locationStyles), B (taxonomy.ts) disjoint → Wave-0 parallel. C (manage-types+settings), D (teams), E (jobs) disjoint → Wave-1 parallel after Wave-0. ✔
- Sync checklist: Task A updates BOTH sync.ts + pull.ts for taxonomy_types AND jobs.type. ✔
- Types: TaxonomyType + the getters/mutations (B) consumed by C/D/E verbatim. ✔
