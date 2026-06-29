# InventoryPro — Backlog

*Single living checklist. Supersedes the scattered "Out of scope" notes in `docs/superpowers/specs/*`.
Last reconciled against the codebase 2026-06-28 (API migrations 001–023, mobile 001–020).*

Status legend: `[ ]` pending · `[~]` partial · `[x]` done (kept here for history) · 🚫 decided against.

---

## A. Repairs / maintenance (extend the v1 system)
- [ ] Repair **assignee/owner** (who is fixing it)
- [ ] **Parts → stock deduction** (consume inventory when a repair uses parts)
- [ ] Repair **cost** tracking
- [ ] **SLA / repair notifications**
- [ ] Equipment **maintenance history** (service dates / what-was-done / costs) + scheduled-service reminders
- [ ] Equipment **depreciation**

## B. Inventory data entry & accuracy
- [ ] **CSV / paste bulk import** of catalog items
- [ ] **Edit / delete from the quick-add tool** (today: use the normal screens)
- [ ] **"Set exact / recount" stock UI** — absolute set / stocktake (only delta adjustments exist today)
- [ ] Bulk sample-data auto-generation (dev tool, low priority)

## C. Labels / QR (v2)
- [ ] Per-printer / label-stock **templates** (DYMO/Zebra)
- [ ] **Batch** label printing
- [ ] Offline client-side QR generation
- [ ] **Label-design editor**
- [ ] Non-QR barcode label formats
- [ ] QR payload **signing / encryption**
- [ ] QR labels for **shelves / locations**
- [ ] **Auto-generated / "quick generate" asset tags** (today: `tag_prefix` hint, tags typed by hand)

## D. Teams & roles
- [ ] **Per-team permission editing UI** (`team_permission_overrides` exists in data; no UI)
- [ ] `view_team_activity` permission + multi-manager teams + cross-team activity (5b leftovers)
- [ ] Cleanup migration: drop the deprecated `teams.manager_id` column

## E. Locations / maps (leftovers)
- [ ] Show stamped **move coordinates on a map** in the log views (data captured, not visualized)
- [ ] Destination-location **proximity sorting** (only source/current is sorted today)

## F. Sync / UX polish & hardening
- [ ] **Reactive post-sync auto-refresh** of already-open lists (pull-to-refresh only today)
- [ ] Taxonomy hardening: migrate entity `type` from **label → FK id** (rename-propagation safety)
- [ ] Drag-and-drop **reorder** for taxonomy (up/down today)

## 🐞 Open bugs
- [ ] (none currently)

## Recently fixed
- [x] **Office-manager checkout/checkin tiles silently failed** *(fixed 2026-06-28)* — dashboard "Check Out Item",
      "Check In", and "My Active Checkouts" tiles were ungated; now wrapped in `PermissionGate`
      (`checkout_inventory` / `checkin_inventory`). Browse stays visible to all.

---

## ✅ Shipped (was previously "out of scope" in specs — kept for history)
Equipment units (tags/serial/status) · repair system v1 · pack sizes · conditional Owner (via location-type rules,
migration 022) · Simple/Detailed form mode (`useFormMode`/`AdvancedFields`) · bulk multi-select
(inventory/equipment/users/jobs, `BulkActionBar`) · Jobs insurance field (016) · item-type→units taxonomy ·
item/unit QR labels (P2) · map pin picker (`MapPickerModal`) + job-site map · maintenance mode · dynamic roles &
teams (014/015) · home-location shelf typeahead · location-type rules (022) · catalog category cleanup +
title-based reclassification (PPE/Filters/Chemicals/Consumables/General, 2026-06-28) · **team-type runtime
management** (taxonomy category `team`, seeded 011, managed in Manage Types — was wrongly listed as pending;
dead `TEAM_TYPES` constant removed 2026-06-28).

## 🚫 Decided against (won't build)
Multi-parent locations · server push / Firebase / `device_push_tokens` / "Send push" bulk action · runtime editing of
the permission **key set** (keys stay hardcoded) · per-field "which fields are advanced" runtime editor · separate
product-type dimension (class *is* the measurement category) · moving equipment models to their own table · offline
map tiles · geofence radius enforcement / auto-switching (suggest-only by design).
