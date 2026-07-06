# InventoryPro — Backlog

*Single living checklist. Supersedes the scattered "Out of scope" notes in `docs/superpowers/specs/*`.
Last reconciled against the codebase 2026-07-05 (API migrations 001–035, mobile 001–029).*

Status legend: `[ ]` pending · `[~]` partial · `[x]` done (kept here for history) · 🚫 decided against.

---

## A. Repairs / maintenance (extend the v1 system)
- [x] Repair **assignee/owner** (who is fixing it)
- [x] **Parts → stock deduction** (consume inventory when a repair uses parts)
- [x] Repair **cost** tracking
- [x] **SLA / repair notifications**
- [x] Equipment **maintenance history** (service dates / what-was-done / costs) + scheduled-service reminders *(verified: `maintenance_events` table + `createMaintenanceEvent`/`getMaintenanceEventsForUnit`/`getUnitsDueForService` in `src/db/queries/maintenance.ts`; add-event sheet + history list in `app/(app)/(equipment)/[id].tsx`; `next_service_at`/`service_interval_months` fields in migration 027; "Service due" local reminder in `src/notifications/localAlerts.ts`)*
- [x] Equipment **depreciation** *(verified: `computeBookValue` — straight_line/declining_balance/units_of_production — in `src/equipment/depreciation.ts`, gated on `view_financial_data` at the `[id].tsx` call site; `purchase_price`/`useful_life_months`/`salvage_value`/`depreciation_method` cols in migration 027)*

## B. Inventory data entry & accuracy
- [x] **Quick Add – Equipment bulk mode** — after the asset-tag box, reveal an optional
      *add-another* asset-tag field so several units can be entered rapidly in one pass;
      nest each unit's **serial** input as a child of its asset tag (visually indented — asset
      tag is the parent, serial the child); and add a **location** selector like the other
      add screens so bulk-added units land in a chosen location.
- [x] **CSV / paste bulk import** of catalog items
- [x] **Edit / delete from the quick-add tool** (today: use the normal screens)
- [x] **"Set exact / recount" stock UI** — absolute set / stocktake (only delta adjustments exist today)
- [ ] Bulk sample-data auto-generation (dev tool, low priority)

## C. Labels / QR (v2)
- [x] Per-printer / label-stock **templates** (DYMO/Zebra) *(verified: `SIZE_PRESETS` incl. "DYMO 3.5×1.1" + "Zebra 2×1" in `app/(app)/(admin)/label-templates.tsx`; `LABEL_TEMPLATES` presets in `src/labels/printLabel.ts` + custom org-synced `label_templates` table, migration 028 / `src/db/queries/labelTemplates.ts`)*
- [x] **Batch** label printing *(verified: `src/components/BatchLabelPrintSheet.tsx` — preset + custom-template chooser, prints N labels from a bulk selection via `printLabels`/`printLabelsWithModel`)*
- [x] Offline client-side QR generation *(verified: `qrcode` dep, `QRCode.toString(...,{type:'svg'})` fully offline in `src/labels/printLabel.ts` + `.web.ts`)*
- [x] **Label-design editor** *(visual drag-canvas designer + custom synced templates, 2026-07-02)*
- [x] Non-QR barcode label formats *(verified: `jsbarcode` dep, `code128Svg` (CODE128) generator + `BarcodeFormat = 'qr' | 'code128'` in `src/labels/printLabel.ts`; `code128` field type in the designer + "Barcode (Code 128)" format chip in `BatchLabelPrintSheet.tsx`)*
- [x] QR payload **signing / encryption** *(HMAC-SHA256, admin-managed key + rotation, grace→strict, 2026-07-02)*
- [x] QR labels for **shelves / locations** *(verified: "🏷 Print QR Label" row → `LabelPrintSheet` in `app/(app)/(locations)/[id].tsx`; `INV:location:<uuid>` payload minted + parsed back by `src/scan/resolveScan.ts` (`{ kind:'location', id }`, UUID-validated). Shelves are location rows, so the same location detail/print path covers them.)*
- [x] **Auto-generated / "quick generate" asset tags** (today: `tag_prefix` hint, tags typed by hand) *(superseded by tag-prefix prefill)*

## D. Teams & roles
- [x] **Force PIN reset on next login when a permission/role change alters `pin_length_required`** —
      if editing a user's role/permissions changes their required PIN length, mark the account so it
      re-runs first-login PIN setup on next sign-in (mirror the admin PIN-reset path).
- [x] **Quick Add – Team: member selection + per-team permissions** — pick team members while creating
      the team and set each member's per-team permission overrides inline (writes `team_permission_overrides`;
      overlaps the "Per-team permission editing UI" item below).
- [x] **Per-team permission editing UI** (`team_permission_overrides` exists in data; no UI)
- [x] `view_team_activity` permission + multi-manager teams + cross-team activity (5b leftovers)
- [x] Cleanup migration: drop the deprecated `teams.manager_id` column

## E. Locations / maps (leftovers)
- [x] **Distinct "shelves" sub-level under locations** —
      - Locations list shows **only locations** by default; shelves are hidden there.
      - Selecting a location that **has shelves** reveals its shelves, each showing which
        location it belongs to + an **optional color**.
      - Shelves are their **own taxonomy category**, surfaced **only in the item-inventory
        context** (assigning/placing an item), never in the general locations browser.
      - UX: **create-if-missing** — typing a new shelf (or location) name creates it inline
        rather than erroring / requiring a separate "add" step.
- [x] Show stamped **move coordinates on a map** in the log views (data captured, not visualized)
- [x] Destination-location **proximity sorting** (only source/current is sorted today)

## F. Sync / UX polish & hardening
- [x] **Sync should mirror REST's target-role guard for privileged-user edits** — a `manage_users`
      holder without `manage_roles_permissions` can currently deactivate/expire a privileged-role
      user (e.g. a `full_admin`) via a sync `UPDATE users {active|expires_at}`, which REST PATCH
      blocks (`PRIVILEGED_ROLES` check). Add the target-role lookup + guard last-admin/self
      deactivation. *(Security fast-follow from 2026-07-01 audit; DELETE-of-privileged already blocked.)*
- [x] **Media thumbnail-object hygiene** — DELETE only collision-checks/cleans the primary object,
      not `thumbnail_url`; thumbnails can be orphaned, and a forged row targeting a victim's
      thumbnail key isn't collision-protected (LOW, needs `upload_media`). Validate + clean thumbnails.
- [x] **Pin `trustProxy` to the proxy subnet** (currently `true`) so `X-Forwarded-For` can't be
      spoofed to evade the roster IP rate-limit if the API is ever reachable outside NPM (LOW).
- [x] **Reactive post-sync auto-refresh** of already-open lists (pull-to-refresh only today)
- [~] Taxonomy hardening: migrate entity `type` from **label → FK id** (rename-propagation safety) — **#74**
  - [x] **Phase 1** (commit `18caffc`): additive soft-FK columns (`teams/jobs/locations.type_id`, `inventory_items.category_id`), deterministic backfill, dual-write (client `resolveTypeId` + server resolve-on-push). No hard FK (unordered outbox).
  - [x] **Phase 2**: reads resolve the display label via the FK id (`resolveLabels` in `queries/taxonomy.ts` + `labelResolve.ts`, wrapped into the team/job/location/item read helpers) so a rename shows immediately everywhere; inventory item-type **filter** switched from label to `category_id`. Rename is now safe-by-construction.
  - [x] **Phase 3a — structural location-type rename safety** *(done 2026-07-05, commit `f27a9cd`)*: `Shelf`/`Vehicle`/`Shop`/`Office` are matched by hardcoded label literals in `queries/locations.ts`; renaming/archiving one would break shelf/vehicle/office logic. Chose the **guard** option (lower risk than a synced `slug` column, which would touch the taxonomy_types sync core): Manage Types now disables rename + archive for those 4 `location_type` rows ("🔒 System type" note), while reorder/icon/color stay editable. NOTE: client-side UI guard only — a device running old code could still rename; a server-side guard remains a possible follow-up.
  - [x] **Phase 3b — `repairs.status` FK cutover** *(done 2026-07-05, commit `1861a6d`)*: migrations API 037 / mobile 031 add `repairs.status_id` + backfill; sync plumbing (pull.ts, `REPAIRS_BASE`, `TAXONOMY_FK_COLUMNS` resolve-on-push); dual-write in createRepair/updateRepairStatus; reads wrapped in `resolveLabels(...,'status_id','status')` so a repair-status rename shows instantly. **`maintenance_events.type` was found to be FREE-TEXT** (users type it; no taxonomy category) → no FK to extend; left as-is. Verified on-device: migration v31 applied, existing repair backfilled.
  - [ ] **Phase 3c** (optional, low priority): `getDistinctValues('category')` autocomplete still returns raw cache labels; and the label caches are still written (dual-write kept — dropping it is risky and low-value). #74 is otherwise complete — renames are safe everywhere.
- [x] Drag-and-drop **reorder** for taxonomy *(verified: `DraggableTypeList`/`DragRow` with a `PanResponder` grab handle in `app/(app)/(admin)/manage-types.tsx` (up/down arrows kept as accessibility fallback); persists via `reorderTaxonomyType(id, sort_order)` in `queries/taxonomy.ts:547`)*

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
- [x] Telemetry: allow anonymous pre-login ingestion (first-launch/login-screen funnel) WITHOUT opening an unauthenticated abuse surface — needs a scoped anon token or IP+rate-limited public path.
- [x] Telemetry: adopt TrackablePressable across high-traffic controls (hub tiles, checkout/checkin, quick-add) so 'action' tap capture is actually live beyond the appendLog audit blend.
- [x] Telemetry: unit-test the ring-buffer eviction path + the /telemetry route handler (auth/rate-limit/maxItems/bad-event-skip).
- [x] Telemetry: exempt /telemetry from the global per-user mut: rate-limit bucket so telemetry can't consume the /sync/push quota (it has its own telemetry: bucket).
- [x] Push: schedule a delayed receipts re-poll (Expo recommends ~15min) in addition to the immediate poll, to catch receipts not ready at send time.

## Camera UX (2026-07-01)
- [x] Add a **flash/torch toggle button** in the camera screen *(verified: tappable torch button in the scanner overlay top bar — `torch` state → `enableTorch={torch}` on the camera, 🔦/💡 icon + accessibility label — in `src/components/BarcodeScanner.tsx` (and `.web.tsx` with capability check). Photo capture uses the OS camera via `ImagePicker.launchCameraAsync` (`src/components/MediaGallery.tsx`), which exposes its own native flash control, so the only in-app camera overlay now has the toggle.)*

## Fixes — pending (2026-07-05)
- [ ] **Reset + email the one-time enrollment ("access") code for users who have never logged in.** Today an admin-created user gets a one-time enrollment code (`users.enrollment_code_hash`, bcrypt, server-only, never synced — migration 026) that they enter along with a new PIN via `POST /auth/set-pin` (auth.ts:205) to complete first-login; `pin_set=false` routes them to the set-PIN screen. Gaps to close: **(1) Reset/regenerate** — an admin action (on `app/(app)/(admin)/users.tsx`, gated by `manage_users`/`set_pins`) to re-issue the enrollment code for any user who hasn't set a PIN yet (`pin_set=false`), invalidating the old code (rehash + store). Add a `POST /users/:id/reset-enrollment-code` (or extend the existing admin PIN-reset path) that generates a fresh code. **(2) 6-digit code** — generate the enrollment code as a **6-digit numeric** code (tighten the current `minLength 4/maxLength 12` on `/auth/set-pin`'s `enrollment_code` to a 6-digit format, and make the generator emit 6 digits). **(3) Email delivery** — send the new code to the user's email. NOTE: the API has **no email/SMTP capability today** — this needs a mail sender added (SMTP creds or a provider like Resend/SES/Postmark, config via env on the Unraid stack; users need an `email` column/value — verify `users.email` exists). **(4) User sets their own PIN** — the existing `/auth/set-pin` first-login flow already lets the user choose their own PIN once they enter the code; reuse it (the user types the emailed 6-digit code + picks a PIN). Touch points: `apps/api/src/routes/users.ts` (admin reset endpoint + code generation), `apps/api/src/routes/auth.ts` (`/auth/set-pin` code-format validation), a new mail module in `apps/api/src/lib/`, and `app/(app)/(admin)/users.tsx` (admin "Reset access code / email it" button, shown for not-yet-enrolled users). Decide: show the code to the admin too (for manual/offline delivery) vs email-only.
- [ ] **Sub-areas should use sub-area location types, not the top-level type list.** When a location being created/edited has a **parent** (i.e. it's a sub-area / child location, `parent_id != null`), the location-type picker should NOT show the same `location_type` taxonomy the top-level locations use (Shop, Vehicle, Warehouse, Job Site, …) — a sub-area is a *part of* its parent, so those types don't make sense. Offer a **sub-area-appropriate set instead** (e.g. **Closet, Section, Storage, Shelf, Area, Bin, Rack**). Implementation options: (a) a separate taxonomy category `location_subtype` seeded with the sub-area types, surfaced by the type picker only when `parent_id` is set; or (b) tag each `location_type` row (via `meta`) as top-level / sub-area / both, and filter the picker by context. Prefer a distinct category so admins can manage the two lists independently in Manage Types. Touch points: `queries/taxonomy.ts` `getLocationTypes`/`LOCATION_TYPE`, the location edit picker (`app/(app)/(locations)/[id].tsx`), and the location quick-add. Ties in with the shelf item below (shelves are already a sub-area concept).
- [x] **Quick Add → Stock: auto-reveal the shelf picker when the location has shelves (⭐ super important).** *(done 2026-07-05 — `StockQuickAdd.tsx` reuses the `SearchablePicker` shelf flow + `getShelvesForParent`/`findOrCreateShelf` + `{id:'__new__'}` sentinel, gated on `has_shelves===1`, same pattern as add.tsx/EquipmentQuickAdd.)* On the Stock quick-add sheet, once a location is chosen, if that location `has_shelves`, automatically show a **shelf input using the SAME component as the other add screens** (the shelf typeahead used in `add.tsx` / `EquipmentQuickAdd` — `findOrCreateShelf*` + the `{ id:'__new__', label }` create-if-missing sentinel), asking **which shelf** the stock goes on. As the user types, **dynamically filter** the location's existing shelves; if none match what they're typing, offer to **add a new shelf** with that name (create-if-missing, inline — same behavior as the other screens). Only surface the shelf field when `has_shelves` is set; hide it otherwise. Component to reuse: the shelf typeahead/`SearchablePicker` shelf flow already wired in the inventory add + equipment quick-add screens (`queries/locations.ts` `findOrCreateShelf`/`findOrCreateShelfByName`).

## Fixes — pending (2026-07-02)
- [x] **Team Members: 404 when promoting a manager immediately after creating a team.** *(verified fixed: `patchTeamMemberRow` in `src/db/queries/teams.ts` flushes local writes with `syncNow()` BEFORE the PATCH, and on a 404 forces one more `syncNow()` + retries once, else throws the friendly "Member is still syncing — try again in a moment." Both `setMemberManagerOnline` and the per-team override path go through it.)* Making a member a manager (or setting a per-team override) goes through the *online* gated endpoint `PATCH /teams/:id/members/:uid` — `is_manager` is server-controlled, so sync ignores client writes and it can ONLY be set via this endpoint (`apps/mobile/src/db/queries/teams.ts:141` `setTeamMemberManager` and `:177` `setTeamPermissionOverride`). But a team + its members created offline live only in the local DB/outbox until the next push, so the server's `team_members` row doesn't exist yet → the `UPDATE … RETURNING` matches nothing → `apps/api/src/routes/teams.ts:~230` returns **404 'Member not found'**. Fix (either/both): (a) after creating a team / adding members, **push the outbox and wait for it to sync BEFORE** allowing the manager toggle (block/spinner the control until synced, or auto-`syncNow()` then retry the PATCH once); (b) make the toggle degrade gracefully on 404 — surface "member still syncing, try again in a moment" instead of a raw error. Preferred: auto-sync-then-PATCH so it "just works" when online; keep the friendly message as the offline fallback.
- [x] **Recount authz mismatch (from 0g audit).** *(verified fixed: `src/components/quickadd/StockQuickAdd.tsx` gates the Set/recount toggle on `const canRecount = usePermission('checkin_inventory')` — the same perm the server INSERT enforces — while Delta/ADJUST stays available regardless.)* The Stock quick-add Set/recount toggle is client-gated only by `quick_add`, but the server INSERT to `stock_by_location` requires `checkin_inventory` (`syncPolicy.ts` OPERATION_PERM). tier3 roles (hr_manager, office_manager: `quick_add=true`, `checkin_inventory=false`) can open the Set toggle and save, but the push is **silently server-rejected**. Fix: gate the Set/recount path on `checkin_inventory` client-side too (or grant recount its own perm), and/or surface the push rejection instead of swallowing it.
- [x] **/sync/push leaks raw pg error message (from API#2 audit).** *(verified fixed: `apps/api/src/routes/sync.ts` now logs the real `(err as Error).message` server-side only via `request.log.warn`, and pushes a generic `{ id, error: 'write rejected' }` to the client conflicts array — no raw pg text reaches the client.)* `apps/api/src/routes/sync.ts:~629` returns `(err as Error).message` inside the `/sync/push` conflicts array — auth-gated and intentional for outbox diagnosability, but a raw Postgres message can reach the client. Fix: map to a generic per-entry conflict reason (log the real error server-side).
- [x] **Mobile full-download misses 7 tables (noticed during rate-limit sizing).** *(verified fixed: `apps/mobile/src/sync/fullDownload.ts` `SYNC_TABLES` now lists all 18 tables — the 9 originals plus `equipment_units`, `app_config`, `taxonomy_types`, `repairs`, `repair_parts`, `maintenance_events`, `label_templates`, `notifications`, `approval_requests` — matching the server `FULL_TABLES` in `apps/api/src/routes/sync.ts` exactly, and each has a download case handler.)*
