# InventoryPro — Full Status

*Reconciled 2026-07-31: `main` @ `79c8a91`, prod = **VPS** `pmshydra@192.168.1.72`
(migrated off Unraid `.239` on 2026-07-21 via `infra/vps/install.sh`), API schema
**73**, mobile schema **55**. Release **1.3.6 (versionCode 4)** built with FCM
baked in — push registration + delivery verified end-to-end on a release build.*

**Board sweep 2026-07-31 complete.** Every live item on GitHub Project 2 is Done or
Rejected except: `#184` schedule board + `#178` repairs workflow (Backlog, deferred by
design), `#185` README review + `#186` backup Drive-connect (await user actions), and
`#23` (fix ships in 1.3.6; closes as field handsets install it). Highlights of the
July wave: vehicles system (#122 epic), media sharing + push (#87/#171/#180/#183),
role dashboards + admin preset editor, UI kit (#94–#121), keyboard-aware forms (#118),
table-scoped reactivity (#63/#64) incl. the full dashboard kit audit, ModalSheet
scroll/inset/responder fixes (#187), picker close-on-blur race fix, VPS backups.

*(The sections below this line are the frozen 2026-06-28 reconciliation, kept as
history — the board is the source of truth for anything open.)*

> **Open work lives on [GitHub Project 2](https://github.com/users/TDHydra/projects/2)** — the single
> source of truth for pending features, deferred enhancements, and decided-against items.
> [`docs/BACKLOG-archive-2026-07-09.md`](./BACKLOG-archive-2026-07-09.md) is the frozen predecessor,
> kept for its per-item verification notes; do not edit it.

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
- Universal media (`media` + MinIO presigned, `s3.invenpro.app`); admin user/role/PIN/override mgmt
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

## ⏭️ Remaining *(superseded — see the 2026-07-31 header block; board = source of truth)*

1. ✅ All six roadmap programs shipped; the 2026-07 board sweep closed everything live.
2. ⏳ **Field rollout of 1.3.6** — `inventorypro-release-1.3.6.apk` (repo root) onto
   the remaining handsets; each upgrade applies the #23 leaked-team-rows purge.
3. ⏳ **User actions**: #185 README once-over, #186 `connect-gdrive.sh` on the VPS.

**Optional future (explicitly deferred / out of scope):**
- P3 v2 / server push — ~~dropped 2026-06-28~~ **reversed 2026-07-01 and SHIPPED (#87)**: Expo Push +
  FCM V1 (Firebase project `invenpro-e6aaf`), server relay in `apps/api/src/lib/push.ts`. Setup runbook:
  `docs/push-setup.md`.
- P4 multi-parent locations — decided out of scope (deep single-parent nesting suffices).

## 🐞 Known bugs / backlog
- ✅ **Maintenance mode blocks admin login** *(fixed 2026-06-28)* — the cause was `enterApp` writing a `login`
  activity-log via the outbox before the session role was wired, so the maintenance write-guard threw and aborted
  sign-in (shown as "connection required"). Fixed in `app/(auth)/login.tsx`: wire `setMaintenanceRole(session.role)`
  first + make the login audit best-effort (try/catch). Sign-in is no longer treated as a blocked write. Client-only.
- ✅ **Job site map** *(done 2026-06-28)* — job detail shows a **view-only Leaflet map** (`MapDisplay`) geocoded from
  `site_address` (`expo-location`), ~35-mile extent pin, no API key. *(Decoupling `site_location_id` from the form is
  still optional/open; the map is address-driven as requested.)*
- ✅ **Location-type form rules** *(done 2026-06-28, migration 022)* — driven by `location_type` meta `{gps, requiresOwner}`:
  type selection auto-sets the icon; GPS hidden for `gps:false` types (Vehicle/Locker/Maintenance/Shelf/Area); owner
  required for `requiresOwner:true` (Vehicle) or when the parent requires it.
- ✅ **Home location = shelf typeahead** *(done 2026-06-28)* — the item Home Location picker now searches **Shelf**-type
  locations by name (prefixes like `WH-A1`), with a fallback to all locations until shelves are entered.

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
