# InventoryPro — Full Status

*As of 2026-06-27 · `main` (through the polish pass `5b38e4bd`)*

## ✅ Done

**Core platform — live in prod (`api.plexcontrol.com`, migrations 001–007):**
- Offline-first stack: Expo SDK 56 + op-sqlite (mobile) · Fastify + Postgres + MinIO (API) · Docker on Unraid
- Sync engine: outbox push + pull-since-timestamp + first-launch full download
- PIN auth + JWT, first-login set-PIN flow
- Permissions: 13 roles, 4 tiers, 19 keys, resolution role default → team → user override (client-side)
- Inventory: catalog items, stock-by-location, add/edit, barcode + USB scan, low-stock alerts
- Locations: tree (parent/sub-areas), create modal, detail, archive (`active`), owner assignment
- Jobs: list, detail (deployments/activity/photos), edit, archive
- Equipment units (Phase 2a): asset-tag tracking, status, deploy/return, basic repair in/out — fully logged
- Checkout/checkin: Job / Location / Production Manager destinations, multi-PM qty, unit + count flows
- Universal media: `media` table, MediaGallery/Thumbnail, presigned S3 (`s3.plexcontrol.com`) working end-to-end
- Admin: user list/create/edit, role + PIN management, permission overrides, role min-PIN
- Standalone APK built + installed, in field use; Unraid SSH management skill

**This session — Foundation wave (reviewed clean):**
- **F1** — Migration 008: job work-order fields + server-assigned `job_number` (sequence + trigger) — `e18acc91` ✅ review clean
- **F3** — Log queries (`getLogForEntity`/`getRecentLog`/`getLogFiltered`) + reusable `ActivityFeed` — `cc6406bb` ✅ review clean
- **Sync 10 s fast-retry** (your request): immediate attempt → 10 s retry until outbox drains → 60 s heartbeat backstop — `b0e2ac9c` ✅
- **F2** — Server-side permission guards on 12 write routes (jobs/locations/users/teams/items) — `26d6f25d` 🔍 in review
- Spec + parallel plan committed

**Completeness push (W1–W6) — all shipped & merged:**
- **W1** Jobs create/edit + work-order fields · **W2** Locations edit/restore + Move-Stock modal · **W3** Equipment edit/retire + repair history · **W4** admin-mutation logging + permission UI · **W5** Teams real screens (roster/create/member-assign) · **W6** Logs admin All-Activity + filters. ✅

**Settings program (3a/3b/3c) + Phase 4:**
- **3a** Settings core + hardening — ✅ merged (`ad3d2236`)
- **3b** Maintenance mode (synced app_config, migration 010, app-wide read-only lockout) — ✅ merged + deployed
- **Polish pass** (SERVPRO rebrand + theme/primitives + UX states + onboarding + modal dismissal/keyboard) — ✅ merged (`5b38e4bd`)

## 🔄 Incomplete (next on the plan)

- **Phase 3c — Simple/Detailed form mode** *(next; never started)*: admin toggle in Settings; **Simple** hides optional/advanced fields across all entry forms (item add, location, job, equipment, quick-add), **Detailed** shows everything. Synced app_config flag (reuse the Phase-3b `app_config` table) or local pref. Forms read the mode and conditionally render their optional field groups.
- **Phase 4 — Notifications**: low-stock alerts + temp-employee-expiry warnings (expo-notifications). (Also listed in backlog.)

## ➕ To be added (backlog — deferred)

- Location-aware UX / multi-parent locations
- Make checkout/checkin move-photos retrievable
- Job batch ops; bulk user ops
- Push notifications for low-stock / temp-employee expiry
- Camera barcode-scan for asset tags (currently manual entry)
- Label templates / auto-generated tags
- Role-definition runtime editor
- **Team type management** — admin screen in Settings (gated behind an approved permission, e.g. tier-4 `system_settings` or a new `manage_team_types`) to add / rename / remove the available Team types at runtime, replacing the hardcoded `TEAM_TYPES` constant (`src/constants/teams.ts`). Needs a synced store (new synced table or `app_config`) so type changes propagate to all devices; the teams create/edit screens read the list from it instead of the constant.
- **Unit type management** — admin screen in Settings (same permission gate as Team type management) to add / rename / remove the available units of measure at runtime, replacing the hardcoded unit list (`UNIT_OPTIONS` in `src/constants/units.ts`). Same synced-store approach so unit changes propagate to all devices; the item add/edit screens read the list from it instead of the constant. **(Subsumed by "Catalog kind & unit taxonomy management" below — build that instead.)**
- **Catalog kind & unit taxonomy management** (recommended approach; supersedes Unit type management) — a permission-gated admin area in Settings to manage the item **kinds** (e.g. Product, PPE, Filters, General — currently the schema only has `kind` product/equipment + free-text `category` + `unit_category`) AND, for each kind, the **set of unit options it allows**. Quick-add and the item add/edit screens then derive the unit picker from the selected kind: e.g. selecting **Product** offers volumetric units / containers / bottles / pack; **PPE** offers boxes / pieces / pair / case / set; etc. Editable at runtime so new kinds and units can be added without a code change (the user expects to add more types later). Backed by a synced store (new synced table(s) or `app_config`) so the taxonomy propagates to all devices. Likely needs a small data-model evolution (a `kinds` table and a `kind_id → allowed units` mapping, migrating the current `kind`/`unit_category`/`category` fields). Scope it as its own spec → plan when picked up; concrete first UX win = the kind-driven unit picker in quick-add.
- **Job type management** — permission-gated admin area in Settings to add / rename / remove **job types** at runtime, each with a selectable **icon** (e.g. Fire damage 🔥, Water damage 💧, Moving 📦, Cleaning 🧽, …). Jobs gain a `type` (new `job_type` field/table + migration); the job create/edit screens get an icon+label type picker (reuse the existing location icon-picker pattern in `src/constants/locationStyles.ts` — `ICON_OPTIONS`/`renderIcon`). Backed by a synced store (new synced table or `app_config`) so types/icons propagate to all devices. Same family as Team-type and Catalog-kind taxonomy management — could share one "taxonomy management" Settings area.
- Server-side stock-quantity re-validation on push (multi-device race safety)
- Postgres `synced_at` parity for `equipment_units`

## ⭐ Extras (added beyond the original ask)

- **Server-side permission enforcement** (F2) — makes the crew-can't-create-jobs gate real, not just UI
- **Auto-incrementing job numbers** — offline-safe via Postgres sequence + trigger, "Pending #" until sync
- **10-second fast-retry sync**
- **Move Stock modal** (W2) — quick location→location transfer vs. the 4-step checkout wizard
- **Per-unit maintenance history timeline** (W3)
- **Reusable ActivityFeed** across location + item + unit detail
