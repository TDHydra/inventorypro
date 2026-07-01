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
- [ ] **Quick Add – Equipment bulk mode** — after the asset-tag box, reveal an optional
      *add-another* asset-tag field so several units can be entered rapidly in one pass;
      nest each unit's **serial** input as a child of its asset tag (visually indented — asset
      tag is the parent, serial the child); and add a **location** selector like the other
      add screens so bulk-added units land in a chosen location.
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
- [ ] **Force PIN reset on next login when a permission/role change alters `pin_length_required`** —
      if editing a user's role/permissions changes their required PIN length, mark the account so it
      re-runs first-login PIN setup on next sign-in (mirror the admin PIN-reset path).
- [ ] **Quick Add – Team: member selection + per-team permissions** — pick team members while creating
      the team and set each member's per-team permission overrides inline (writes `team_permission_overrides`;
      overlaps the "Per-team permission editing UI" item below).
- [ ] **Per-team permission editing UI** (`team_permission_overrides` exists in data; no UI)
- [ ] `view_team_activity` permission + multi-manager teams + cross-team activity (5b leftovers)
- [ ] Cleanup migration: drop the deprecated `teams.manager_id` column

## E. Locations / maps (leftovers)
- [ ] **Distinct "shelves" sub-level under locations** —
      - Locations list shows **only locations** by default; shelves are hidden there.
      - Selecting a location that **has shelves** reveals its shelves, each showing which
        location it belongs to + an **optional color**.
      - Shelves are their **own taxonomy category**, surfaced **only in the item-inventory
        context** (assigning/placing an item), never in the general locations browser.
      - UX: **create-if-missing** — typing a new shelf (or location) name creates it inline
        rather than erroring / requiring a separate "add" step.
- [ ] Show stamped **move coordinates on a map** in the log views (data captured, not visualized)
- [ ] Destination-location **proximity sorting** (only source/current is sorted today)

## F. Sync / UX polish & hardening
- [ ] **Sync should mirror REST's target-role guard for privileged-user edits** — a `manage_users`
      holder without `manage_roles_permissions` can currently deactivate/expire a privileged-role
      user (e.g. a `full_admin`) via a sync `UPDATE users {active|expires_at}`, which REST PATCH
      blocks (`PRIVILEGED_ROLES` check). Add the target-role lookup + guard last-admin/self
      deactivation. *(Security fast-follow from 2026-07-01 audit; DELETE-of-privileged already blocked.)*
- [ ] **Media thumbnail-object hygiene** — DELETE only collision-checks/cleans the primary object,
      not `thumbnail_url`; thumbnails can be orphaned, and a forged row targeting a victim's
      thumbnail key isn't collision-protected (LOW, needs `upload_media`). Validate + clean thumbnails.
- [ ] **Pin `trustProxy` to the proxy subnet** (currently `true`) so `X-Forwarded-For` can't be
      spoofed to evade the roster IP rate-limit if the API is ever reachable outside NPM (LOW).
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

## Notifications/Telemetry follow-ons (from 2026-07-01 ultramode review, commit bc2147e)
- [ ] Telemetry: allow anonymous pre-login ingestion (first-launch/login-screen funnel) WITHOUT opening an unauthenticated abuse surface — needs a scoped anon token or IP+rate-limited public path.
- [ ] Telemetry: adopt TrackablePressable across high-traffic controls (hub tiles, checkout/checkin, quick-add) so 'action' tap capture is actually live beyond the appendLog audit blend.
- [ ] Telemetry: unit-test the ring-buffer eviction path + the /telemetry route handler (auth/rate-limit/maxItems/bad-event-skip).
- [ ] Telemetry: exempt /telemetry from the global per-user mut: rate-limit bucket so telemetry can't consume the /sync/push quota (it has its own telemetry: bucket).
- [ ] Push: schedule a delayed receipts re-poll (Expo recommends ~15min) in addition to the immediate poll, to catch receipts not ready at send time.

## Camera UX (2026-07-01)
- [ ] Add a **flash/torch toggle button** in the camera screen so users can quickly turn the flash on/off while capturing (barcode scan + photo capture). expo-camera supports `enableTorch` / `flashMode` — surface it as a tappable control in the camera overlay.
