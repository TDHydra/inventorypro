# Location Types + Sections + Shelf/Home-Location — Design Spec

*Date: 2026-06-28 · Decisions locked with user.*

## Goal
Make Vehicles, Lockers, and Maintenance first-class **location types** (production-manager inventory), and add a
**shelf / "home location"** reference so each item shows *where it belongs* and shelves are labelable. Reuses the
existing locations + stock engine (locations already hold stock via `stock_by_location`).

## Decisions
- Vehicles/Lockers/Maintenance = a **`location_type` taxonomy** (Shop, Vehicle, Locker, Maintenance, Warehouse,
  Job Site, Shelf, Area). Locations get a `type`. Sections = the locations list filtered by type.
- **Home location**: items get `home_location_id` → the location (often a shelf) where the item belongs, shown
  prominently so crews can find where it goes. Shelves are just locations of type "Shelf" (deep nesting already
  supported). Labeling = the shelf's name + path (QR labels for locations = later).
- Easiest add-stock: an **"Add stock here"** action on location detail that opens Add-Stock pre-targeted to it.

## Data model (migration — follows docs/SYNC-MIGRATION-CHECKLIST.md)
- **API `019_location_types.sql`**:
  - `ALTER TABLE locations ADD COLUMN IF NOT EXISTS type TEXT;`
  - `ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS home_location_id UUID;` (nullable, **no FK** — sync order
    safety, like other soft refs)
  - Seed `location_type` taxonomy_types (idempotent by category+label): Shop 🏪, Vehicle 🚐, Locker 🔒,
    Maintenance 🔧, Warehouse 🏭, Job Site 🚧, Shelf 🗄️, Area 📍.
- **Mobile `017_location_types_item_home.ts`**: `ALTER TABLE locations ADD COLUMN type TEXT`,
  `ALTER TABLE inventory_items ADD COLUMN home_location_id TEXT`. Register in `schema.ts`.
- **pull.ts**: add `type` to the `locations` upsert (cols + ? + rowToValues `row.type ?? null`); add
  `home_location_id` to the `inventory_items` upsert (cols + ? + rowToValues). Keep col/placeholder parity.
- **Interfaces/queries**: `Location.type?: string|null` (upsertLocation + any updateLocation*); `InventoryItem
  .home_location_id?: string|null` (upsertItem + updateItemFields field list).
- **sync.ts**: locations + inventory_items sync dynamically (no SELECT_COLUMNS override) → confirm NO change.

## UI
1. **Location create/edit form** (`app/(app)/(locations)/index.tsx` + detail): a "Location type" icon-chip picker
   from `getTaxonomyTypes('location_type')` → stores `type`.
2. **Locations list**: type filter chips (All + one per type) at the top; show each location's type icon. Gives the
   Vehicles / Lockers / Maintenance "sections" via filter.
3. **Manage Types**: add `location_type` as a managed category (add/rename/icon/reorder/active), like item types.
4. **Item add/edit + quick-add**: a "Home location (where it belongs)" `SearchablePicker` of locations (full-path
   labels via the existing path helper) → stores `home_location_id`.
5. **Item detail + search rows**: show the home-location path ("Belongs at: Shop › Aisle 3 › Shelf B") prominently.
6. **Location detail**: an "Add stock here" button → Add-Stock pre-targeted to that location id.

## Build order
- **Foundation (do first, carefully):** migrations (api 019 + mobile 017) + pull.ts wiring + interfaces + queries.
- **UI (parallel, file-disjoint):** (a) location form+list+Manage Types `location_type`; (b) item home-location
  picker (add/quick-add/edit) + detail/search display; (c) location-detail "Add stock here".

## Verification
- tsc clean (mobile + api). Migrations apply on prod; `location_type` rows seeded; `locations.type` +
  `inventory_items.home_location_id` columns present. pull col/placeholder parity. Sync round-trips a location
  type + an item home location. No FK errors on out-of-order sync.

## Out of scope (later)
- QR labels for shelves/locations (reuse the P2 label service). Pack sizes, repair system, vehicle repair — separate workstreams.
