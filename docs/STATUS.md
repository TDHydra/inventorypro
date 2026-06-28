# InventoryPro — Full Status

*Reconciled 2026-06-28 against verified ground truth: `main` first-parent history,
the API migration set (`apps/api/src/db/migrations/001–015`), and **prod** (Unraid
`192.168.1.239`, `inventorypro-postgres-1` — all 15 migrations applied, confirmed).*

`main` HEAD at reconciliation: `cc0f185` (perms-reactive fix).

---

## Build order (locked with user)

**P2 → P1 → P6 → P3 → P4 → P5.** Status below is **verified against the repo + prod**, not memory.

| Program | Status | Evidence |
|---|---|---|
| **P2** Labeling & Scanning | ✅ done + deployed | merge `eb9949d`, deps reconcile `64dc211`; `/labels/*` live |
| **P1** Configurable Taxonomies | ✅ done + deployed | merges `225fa4b` (team+job types), `a0895d5` (equipment system), `980fcf3` (product classes + conditional owner), fix `08ebd8b`; migrations 011, 012 |
| **P6** Data & Sync Hardening | ✅ done + deployed | merge `c9dbdfb`; migration 013 |
| **P3** Notifications | ✅ code-complete (needs APK rebuild) | merge `30eeadf`; on-device local low-stock + expiry alerts; `expo-notifications@~56.0.18` (native → rebuild) |
| **P4** Locations | ✅ done | merges `e703a69` (P4a GPS modes), `3264f01` (P4b deep nesting). Multi-parent join **decided out of scope** (deep single-`parent_id` nesting + any-parent picker covers the need) |
| **P5** Roles/Perms/Teams | ✅ done (one deferred sub-item) | 5a dynamic roles (`937bdc0`) + override-diff polish (`268925b`), 5b multi-manager teams (`a8b6abd`), 5c bulk ops phases 1+2 (`f59f04b`, `6590bae`) + phase-3 insurance field (`0debf29`, migration 016). **Deferred:** 5c "Send push" user-bulk action → ships with P3 |

---

## ✅ Done — merged to `main` and deployed to prod

**Core platform (migrations 001–010):**
- Offline-first stack: Expo SDK 56 + op-sqlite (mobile) · Fastify + Postgres + MinIO (API) · Docker on Unraid
- Sync: outbox push + pull-since-timestamp + first-launch full download; 10s fast-retry + 60s heartbeat; NetInfo-ungated (fetch is source of truth)
- PIN auth + JWT, first-login set-PIN; server-side permission guards on write routes
- Inventory: catalog, stock-by-location, add/edit, barcode + USB scan, low-stock; Move-Stock modal
- Locations: tree, create/edit, archive, owner; Jobs: list/detail/edit/archive + server-assigned `job_number`
- Equipment units: asset-tag tracking, status, deploy/return, repair history — fully logged
- Checkout/checkin: Job / Location / Production Manager destinations, multi-PM, unit + count flows; retrievable move-photos
- Universal media (`media` + MinIO presigned, `s3.plexcontrol.com`); admin user/role/PIN/override mgmt
- Settings 3a (core) · 3b (maintenance mode, app_config, migration 010) · 3c (Simple/Detailed form mode) · SERVPRO rebrand/polish pass
- Standalone APK in field use

**P2 · Labeling & Scanning** (`eb9949d`, `64dc211`):
- API `GET /labels/item/:id/qr.png` + `/labels/unit/:assetTag/qr.png` (qrcode lib, auth-gated; encodes `INV:item:<id>` / `INV:unit:<tag>`)
- Mobile "Print label" via `expo-print` (native — in the dev-client/APK); camera asset-tag scan; auto-generated asset tags (`tag_prefix` increment)
- Deps: server `qrcode`, mobile `expo-print` — both in `pnpm-lock.yaml` (repo uses **pnpm**, not npm)

**P1 · Configurable Taxonomies** (`225fa4b`, `a0895d5`, `980fcf3`, `08ebd8b`; migrations 011, 012):
- `taxonomy_types` synced table (migration 011) + admin "Manage Types" (tier-4) + generic icon+label picker
- **Team types** (replaces hardcoded `TEAM_TYPES`) · **Job types** with icons (`jobs.type` + picker)
- **Equipment as its own system** — dedicated Equipment tab (list/add/detail), inventory is products-only; unit mgmt moved to equipment/[id]; in-SQL `kind`/`unit_tracked` filters in `searchItems`
- **Product classes (kind→allowed-units)** + **conditional Owner** parent rule (migration 012; enum→TEXT fix `08ebd8b` per the PG-enum trap)

**P6 · Data & Sync Hardening** (`c9dbdfb`; migration 013):
- Job reference # · equipment_units `synced_at` parity · server-side stock re-validation on push · move-photos surfaced

**P4a · GPS anchor input modes** (`e703a69`): manual lat/lng · use-current · map picker (`react-native-maps`, native)
**P4b · Deeper location nesting** (`3264f01`): recursive location tree + any-parent picker (single `parent_id`)

**P5 · Roles, Permissions & Teams:**
- **5a Dynamic Roles & Permissions** (`937bdc0`; migration 014): runtime role→permission assignment, synced via `role_settings.permission_overrides`, resolver falls back to `ROLE_DEFAULTS`; matrix UI. Reactivity fix `cc0f185` (useSyncExternalStore so changes show without remount — see memory `project_inventorypro_reactive_cache`)
- **5b Multi-manager teams + cross-team activity** (`a8b6abd`; migration 015): `team_members.is_manager` (migrated from single `teams.manager_id`); multi-select manager + member pickers; "My team's activity" view gated by `view_team_activity`

---

## ✅ P5 · 5c phase 1 — Bulk multi-select ops (done, `feat/p5c-bulk-ops`)

JS-only (no migration/native/perm/sync-table change). tsc clean; adversarial review passed (parity fixes applied).
- Unit 1 — `useMultiSelect` hook + `BulkActionBar` (`d22aede`)
- Units 2+3 — Users (deactivate/reactivate, change role, add-to-team, reset PIN) + Jobs (close/archive/reopen/set-type) (`25b8a36`)
- Spec: `docs/superpowers/specs/2026-06-28-p5c-bulk-ops-design.md` · Plan: `…/plans/2026-06-28-p5c-bulk-ops-PARALLEL.md`
- Native note: JS-only → reaches the dev client over Metro; bundle into the next APK rebuild (no new native module).

---

## ⏭️ Remaining

**All six roadmap programs (P1–P6) are code-complete and merged to `main`. The release APK is built and the API is deployed.**

1. ✅ **Native rebuild** — `npx expo prebuild --clean` → re-pinned Gradle 8.13 → `assembleRelease` against prod URL.
   Output: `~/inventorypro/inventorypro-preview.apk` (130MB, 2026-06-28; Hermes; prod URL + POST_NOTIFICATIONS verified baked in).
2. ✅ **API deployed** — image rebuilt, shipped to Unraid, migration 016 (insurance_carrier) applied; `schema_migrations` max=16;
   `https://api.plexcontrol.com/health` = ok; `jobs.insurance_carrier` confirmed in prod.
3. ⏳ **On-device verification** (user) — install `inventorypro-preview.apk`, accept the notification permission, and confirm
   P3 alerts fire once per episode (low-stock + temp-employee expiry) and re-fire after recovery.

*Optional / deferred:* a **dev-client** APK rebuild is only needed for Metro-connected development — the preview APK above
points at prod and is sufficient to field-test notifications directly.

**Optional future (explicitly deferred / out of scope):**
- P3 v2 / server push — **dropped (no Firebase, user's call 2026-06-28).**
- P4 multi-parent locations — decided out of scope (deep single-parent nesting suffices).

## 🐞 Known bugs / backlog
- **Maintenance mode blocks admin login** *(reported 2026-06-28)* — when maintenance mode is ON, logging in as
  an admin fails with **"connection required."** Admins/tier-4 must be able to sign in *during* maintenance (to
  turn it off / manage). Likely the maintenance write-guard (`assertWritable`) or a server-side maintenance gate is
  firing on the online PIN auth (`POST /auth/token`) path. Fix: exempt the auth/login path (and tier-4) from the
  maintenance lockout. Check `apps/api` maintenance handling + the mobile login flow's session writes.
- **Job site location → street address + map pin** *(requested 2026-06-28)* — the job's "site location" should NOT
  reuse the internal location picker. It just needs a **street address** field + a **map with a pin** showing where
  the job is, rendered on a **~35-mile-radius** map view. Decouple `jobs.site_location_id` UX from the warehouse
  location tree (keep `site_address`; the map pin can reuse the existing lat/lng + react-native-maps from P4a).
- **Location-type form rules** *(requested 2026-06-28)* — the location create/edit form should adapt to the selected
  type (drive from config on the `location_type` taxonomy meta — e.g. `{gps, requiresOwner}` — so it stays adjustable):
  - selecting a type **auto-sets the icon** to that type's icon;
  - **Vehicle**: hide the GPS anchor; **owner ("Belongs to") is required** (a vehicle belongs to a PM);
  - **Locker**: minimal — just the name (one Locker location covers all 4 lockers; no GPS, no owner, no sub-areas);
  - **Maintenance**: it's at the shop and uses **labeled shelves** (normal location; relies on the shelf/home-location system).
- **Home location = shelf typeahead** *(requested 2026-06-28)* — the item **Home Location** picker (edit/add/quick-add)
  should **search a table of shelves as you type**, not a deep breadcrumb tree. Shelves are entered with **prefixes per
  warehouse/shop** (e.g. `WH-A1`, `SHOP-B3`) so selection stays simple. Likely: filter `locations` of type `Shelf`
  (or a dedicated shelf label field) and typeahead on the prefix/name.

---

## Conventions that bind remaining work
- **Sync-migration checklist** (`docs/SYNC-MIGRATION-CHECKLIST.md`): any migration adding a *synced* column/table MUST update
  `apps/api/src/routes/sync.ts` (ALLOWED_TABLES/FULL_TABLES/CONFLICT_TARGETS) **and** `apps/mobile/src/sync/pull.ts`
  (TABLE_UPSERT_SQL + rowToValues) in the same change.
- **PG enum trap** (memory `project_inventorypro_pg_enum_trap`): Postgres ENUM cols are TEXT on mobile SQLite; ALTER enum→TEXT before remapping values or the prod API crash-loops.
- **pnpm only** — install deps with `pnpm` (Dockerfile uses `--frozen-lockfile`); never `npm` (breaks the API build).
- **Native deps require a rebuild:** P3 (expo-notifications). Batch native changes to keep rebuild count low.
- **Outbox correctness:** strip local-only `synced_at`; users writes use real booleans (`active: !!v`), never 0/1.
- **Prod deploy:** `docker compose build api` → tag `inventorypro-api:latest` → `save|gzip` → scp to `root@192.168.1.239:/mnt/user/appdata/inventorypro/` → `docker load` + `compose -f docker-compose.prod.yml up -d api` (migrations auto-run).
