# InventoryPro — Backlog Roadmap

*Date: 2026-06-27 · Master plan organizing the full backlog into sequenced programs.*

Each **program** below is an independent subsystem that gets its own
`brainstorm → spec → plan → SDD build → merge` cycle when picked up (the same flow
used for Settings 3a/3b/3c and the polish pass). This doc is the meta-plan; it is NOT a
single implementation plan. Build order (locked with user): **P2 → P1 → P6 → P3 → P4 → P5**.

> **Progress (verified 2026-06-28 vs `main` + prod migrations 001–016):**
> ✅ **P2** · ✅ **P1** · ✅ **P6** · ✅ **P4** (P4a GPS + P4b deep nesting; multi-parent decided out of scope) ·
> ✅ **P5** (5a + override-diff polish, 5b, 5c phases 1+2 + insurance field; "Send push" deferred to P3) ·
> ❌ **P3 Notifications — the only program left.**
> See `docs/STATUS.md` for per-merge evidence and the P3 plan.

Conventions that bind every program:
- **Sync-migration checklist** (`docs/SYNC-MIGRATION-CHECKLIST.md`): any migration adding a *synced*
  column/table MUST update `apps/api/src/routes/sync.ts` (ALLOWED_TABLES/FULL_TABLES/CONFLICT_TARGETS)
  AND `apps/mobile/src/sync/pull.ts` (TABLE_UPSERT_SQL + rowToValues) in the same change.
- **Native deps** (flagged per program) require a dev-client + release-APK rebuild, not just a Metro reload.
- Admin-config features gate on the existing tier-4 `system_settings` permission.
- Reuse: `app_config` (synced k/v, Phase 3b), `app_settings` (local k/v), the `ui/*` primitives + `theme.ts`,
  `confirmDestructive`, the location icon picker (`src/constants/locationStyles.ts` `ICON_OPTIONS`/`renderIcon`).

---

## P2 · Labeling & Scanning  *(first)*
**Items:** QR code generation + label printing · label templates / auto-generated tags · camera barcode-scan for asset tags.
**Goal:** print scannable QR labels for products/equipment and scan them back.
- **API:** `GET /items/:id/qr` (and/or `/equipment/:id/qr`) → render QR (PNG/SVG) via a `qrcode` lib, encoding a deep-linkable item/asset id (`inventorypro://item/<id>` or the barcode). Add a **label-template** config (label stock sizes/layouts — e.g. 2.25×1.25 thermal, Avery sheets) and a render endpoint or client-side compose (name + QR + code).
- **Mobile:** "Print label" action on item/equipment detail → pick template → `expo-print` (native dep) / share sheet to a label printer. **Auto-generated asset tags**: extend the existing `tag_prefix` to auto-increment per prefix on equipment create. **Camera asset-tag scan**: reuse `BarcodeScanner` (CameraView) in the asset-tag entry (the `BarcodeInput` already has an inline Scan button — extend to equipment asset tags), replacing manual entry.
- **New deps:** server `qrcode` (+ maybe `pdfkit`/`sharp` for label sheets); mobile `expo-print` (native → rebuild).
- **Migration:** none required (uses existing ids); optional `asset_tag_seq` for auto-increment.
- **Size:** Medium.

## P1 · Configurable Taxonomies  *(highest leverage)*
**Items:** Team type management · Catalog **kind → allowed-units** taxonomy (subsumes Unit type management) · Job types (with icons) · Conditional-Owner parent rule + admin config.
**Goal:** runtime-editable, synced, admin-managed type lists that the forms read from — no code change to add a type.
- **Shared foundation (build once):** a synced config store for taxonomies (new synced table(s) e.g. `taxonomy_types(id, kind, name, icon, sort, active, …)` + a `kind_units(kind_id, unit)` mapping, OR structured `app_config` JSON), an admin **"Manage Types"** Settings area (tier-4), and a **generic icon+label picker** component (reuse `renderIcon`/`ICON_OPTIONS`).
- **Plug-ins:** **Item kind→units** (Product→volumetric/containers/bottles/pack; PPE→boxes/pieces/pair/case/set; …) — quick-add & item add/edit derive the unit picker from the selected kind; needs a data-model evolution migrating `kind`/`unit_category`/`category`. **Job types** (jobs get `type_id`, picker with icons — Fire 🔥/Water 💧/Moving 📦/Cleaning 🧽). **Team types** (replace hardcoded `TEAM_TYPES`). **Conditional Owner**: admin configures which parent locations require an owner; location form shows Owner only for qualifying subareas.
- **New deps:** none (RN only). **Migration:** yes (taxonomy tables + jobs.type_id + item kind model) — sync-migration checklist applies.
- **Size:** Large (decompose into: foundation → kind/unit → job types → team types → conditional owner). The single most-requested area.

## P6 · Data & Sync Hardening  *(quick wins)*
**Items:** manual/external job reference # · equipment_units `synced_at` parity · checkout/checkin move-photos retrievable · server-side stock re-validation on push.
- **Job reference #:** migration add nullable `jobs.reference_number`; (advanced) field on job create/edit; sync wiring (checklist). Small.
- **equipment_units synced_at parity:** ensure `synced_at` handling matches other tables (Postgres column / pull-skip consistency). Small.
- **Move-photos retrievable:** photos attached during checkout/checkin land in `media` (entity_type `checkout`/`checkin`) but aren't surfaced — show them in the job/activity/equipment views. Small-medium.
- **Server stock re-validation:** in `sync.ts applyEntry` for `stock_by_location`, re-validate/clamp quantities on push to prevent negative stock / multi-device races (authoritative server merge). Medium, backend correctness.
- **New deps:** none. **Migration:** yes (reference_number, maybe equipment_units). **Size:** Small overall — a good derisking bundle.

## P3 · Notifications (Phase 4)
**Items:** low-stock alerts · temp-employee-expiry warnings.
- `expo-notifications` (native dep → rebuild). v1 = **local notifications** computed on-device: after each sync, check `getLowStockItems()` and temp-employee `expires_at`, schedule/fire local notifications (dedupe so they don't re-fire). Optional v2 = server-scheduled push (a cron in the API + device push tokens) for when the app is closed.
- **New deps:** expo-notifications (native). **Migration:** maybe a `device_push_tokens` table for v2. **Size:** Medium.

## P4 · Locations
**Items:** GPS anchor 3 input modes (manual / current / map) · location-aware UX / multi-parent locations.
- **GPS map picker:** `react-native-maps` (native dep → rebuild) — tap-to-set lat/lng, plus manual entry + the existing current-location. (Folds into P1's conditional-owner location work.)
- **Multi-parent / location-aware UX:** locations currently have a single `parent_id`; multi-parent is a real data-model change (join table) + UX — scope carefully, likely its own sub-spec.
- **New deps:** react-native-maps (native). **Migration:** yes (multi-parent join). **Size:** Medium-Large.

## P5 · Roles, Permissions & Teams *(the admin control center — "really been lacking attention")*
**Items:** dynamic roles & permissions editor · multi-manager teams + membership · cross-team activity visibility · bulk user ops · job batch ops.

### 5a · Fully-dynamic Roles & Permissions page
Today permission **assignment** is the compile-time `ROLE_DEFAULTS` constant; only per-user `permission_overrides` are runtime. Make assignment fully runtime-editable + synced so any feature can be turned on/off fast for any role/person, without a rebuild.
- **Key decision (user):** permission **keys** stay hardcoded (new capabilities ship in code) — only their **on/off assignment per role** becomes dynamic. So: a synced `role_permissions(role, permission, allowed)` store that the resolver reads (falling back to `ROLE_DEFAULTS` for any key not yet in the store), behind the existing 3-level resolution (role default → team override → user override).
- **UI:** a real **Roles & Permissions matrix** screen (admin/tier-4): roles × the ~19 permission keys, each a toggle; per-user override list (already partly exists) highlighting diffs from the role default. Synced via the migration checklist.
- **Size:** Large. **Migration:** yes (`role_permissions`). Decompose: synced store + resolver change → matrix UI → per-user override polish.

### 5b · Teams — multi-manager, membership, cross-team visibility
- **Multiple managers per team (user):** `teams.manager_id` is single today → support **multi-select managers** (e.g. Frank *and* Todd both manage a team). Cleanest model: add `is_manager BOOLEAN` (or a `role` member/manager) to `team_members` so managers are members flagged as managers; migrate the existing single `manager_id`. Team edit screen gets a multi-select manager picker + a member picker (designate who's in the team).
- **Cross-team activity visibility (user):** a manager (e.g. production manager) can see **what their team members do — for this team and for others**. Implement as an activity-log scope: "My team's activity" view that queries `activity_log` for the union of the manager's teams' members across all jobs/teams, gated by a `view_team_activity` permission (managed in 5a). Builds on the existing `getLogFiltered`.
- **Size:** Medium-Large. **Migration:** yes (`team_members.is_manager`). Pairs naturally with 5a (the visibility permission lives in the dynamic permissions store).

### 5c · Bulk ops
- Multi-select + batch actions (deactivate, reassign, archive) on the user and job lists. Medium. No migration.

**Note:** the user flagged this whole program as overdue ("really been lacking attention"). Sequence is currently P5-last, but **5a/5b are a candidate to pull forward** if roles/teams become the priority — say the word and I'll reorder.

---

## Cross-cutting notes
- **Native rebuilds needed by:** P2 (expo-print), P3 (expo-notifications), P4 (react-native-maps). Batch these so the dev-client/APK rebuild count stays low.
- **Migrations needed by:** P1, P6, P3 (v2), P4, P5 — all must follow the sync-migration checklist.
- **Decompose-on-pickup:** P1, P4, P5 are large enough to each split into multiple specs; the rest are single-spec sized.
- **Next action:** when starting P2, run `brainstorming` on it specifically (QR encoding format, label template set, printer target) → spec → plan → SDD.
