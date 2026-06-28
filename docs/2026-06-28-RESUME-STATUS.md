# InventoryPro — Resume Checkpoint (2026-06-28)

*A clean place to pick up. Authoritative roadmap status lives in `docs/STATUS.md`; this doc is the
"where we are + what's next" snapshot from the 2026-06-28 iteration session.*

## State of the world
- **All six roadmap programs P1–P6 are done, merged to `main`, and deployed.**
- **Prod** (`api.plexcontrol.com`, Unraid `192.168.1.239`, `inventorypro-postgres-1`): **API migrations 001–019 applied**, health = ok.
- **Mobile** SQLite migrations 001–017 (api is ahead because 017/018 were data-only seeds).
- Latest **APK** = `~/inventorypro/inventorypro-preview.apk`, installed on the Pixel (`58060DLCQ001ZR`), points at prod.
- `main` HEAD around `aa9b174` (locations UI + item# search). tsc clean (mobile + api) throughout.

## Built this iteration session (all shipped)
- **Sync recovery** — failed outbox entries are now visible + retryable (tap the sync dot → Retry/Discard); server logs push conflicts.
- **Item Type taxonomy** (`item_category`: PPE/Filters/Consumables/Chemicals/General) replacing the equipment toggle in quick-add; **type drives units**; **editable + reorderable units per type** and **editable unit-class per type** in Manage Types; **Inventory filter by type**; **bulk "Set item type"** backfill.
- **Equipment** stays its own tab (items here are always `kind='product'`).
- **Scanner redesign** — branded viewfinder, animated scan line, **torch toggle**, polished permission screen.
- **Add-Media modal** — polished bottom sheet (camera / library cards) replacing the bare Alert.
- **Quick-add** — item # / part # field (encouraged) with **duplicate detection** (existing item # → tap to open it or cancel).
- **Locations overhaul** (migration 019 / mobile 017):
  - `location_type` taxonomy (Shop, Vehicle, Locker, Maintenance, Warehouse, Job Site, Shelf, Area) — managed in Manage Types.
  - `locations.type` + a **type picker** on create/edit + **type-filter sections** on the locations list (Vehicles/Lockers/Maintenance views).
  - **Shelf / home location**: `inventory_items.home_location_id` + a "Home location (where it belongs)" picker on quick-add/add/edit + **"Belongs at: Shop › Aisle › Shelf"** on item detail.
  - **"Add stock here"** button on location detail → Add-Stock pre-targeted to that location (`locationId` param).

## Next up — decided, NOT yet built (in priority order)
1. **Pack sizes** *(entry-helper model — user's pick)*: add `inventory_items.pack_size` (units per pack) + a base unit.
   Stock stays in the **base unit**; when adding stock you choose **"X packs" (×pack size)** or **"X units"** (fractions
   like 0.5 ok). e.g. SERVPRO Orange = 4 gal/pack; #202 Glass = a dozen cans; but you can add 1 jug / half a gallon.
   - Touches: migration (api + mobile, sync checklist) for `pack_size`; quick-add + add-stock UI (pack/loose toggle);
     stock-write math (multiply packs × pack_size into base units). No new taxonomy.
2. **Repair system** *(equipment + general + vehicle — user's pick)*: repair **tickets** attaching to an equipment unit,
   a general item/asset, **or a vehicle (location of type Vehicle)**, with **notes**, **parts needed**, and an
   **admin-configurable status taxonomy** (`repair_status` — Open/Awaiting Parts/In Progress/Done, editable like job types).
   - Touches: new `repairs` table (migration + sync wiring), a `repair_status` taxonomy seed, repair list/detail screens,
     a status taxonomy section in Manage Types. Builds on existing per-equipment-unit repair history.

## Backlog / bugs (see `docs/STATUS.md` "Known bugs")
- 🐞 **Maintenance mode blocks admin login** ("connection required") — tier-4/auth path must bypass the maintenance
  lockout so an admin can sign in to turn maintenance off. (Check api maintenance gate + mobile login session writes.)
- **Job site location → street address + map pin** — stop reusing the warehouse location picker for a job's site; just a
  street-address field + a map pin on a ~35-mile-radius map (reuse P4a lat/lng + react-native-maps).

## How to resume / ship (reference)
- **Mobile build**: `cd apps/mobile/android && EXPO_PUBLIC_API_URL=https://api.plexcontrol.com ./gradlew assembleRelease`
  → `cp` to `inventorypro-preview.apk` → `adb install -r`. (Gradle pinned 8.13; re-pin after any `expo prebuild --clean`.)
- **API deploy**: `cd infra && docker compose build api` → `docker tag infra-api:latest inventorypro-api:latest` →
  `docker save … | gzip > inventorypro-api.tar.gz` → `scp` to Unraid → `docker load` + `docker compose -f
  docker-compose.prod.yml up -d api` (migrations auto-run). **pnpm only** — never `npm`/`expo install` without
  reconciling (`rm package-lock.json && pnpm install`).
- **Sync-migration checklist** (`docs/SYNC-MIGRATION-CHECKLIST.md`): a synced column needs `sync.ts` (if hardcoded) +
  `pull.ts` (TABLE_UPSERT_SQL cols/placeholders + rowToValues) + the mobile migration + interface + upsert/update.
- **Taxonomy model**: `taxonomy_types(category, label, icon, sort_order, active, meta)`. Categories in use: `team`,
  `job`, `product_class` (meta = {units, allowDecimals}), `item_category` (meta = {units, classId}), `location_type`.
  Helpers in `apps/mobile/src/db/queries/taxonomy.ts`: `getItemTypes`, `getLocationTypes`, `parseItemTypeMeta`,
  `setTaxonomyUnits`, `setTaxonomyClassId`. Manage Types screen renders a section per category.
- Verify-on-device still pending: notifications fire (P3), sync Retry clears stuck entries, new locations/items features.
