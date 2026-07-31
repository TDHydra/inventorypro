# RESUME: Vehicles UI wave (#152 / #155 / #167 / #168)

**Written 2026-07-23, end of session. Pick up here tomorrow.**

## Where things stand

- **Schema phase 0 is DONE and MERGED to `main`** (fast-forward to `70d2fca`, 11 commits incl. spec `0419c38` + plan `14d3d7e`). Suites verified on the merge: API 417/417, mobile 574/574, tsc clean both. Device-verified via hotload (migrations 053/054 applied, vehicle opens, lock toggles).
- **`main` is NOT pushed** — origin/main is 11 commits behind. Push before/when starting.
- Spec: `docs/superpowers/specs/2026-07-23-vehicles-schema-phase0-design.md`. Plan: `docs/superpowers/plans/2026-07-23-vehicles-schema-phase0.md`. Ledger: `.superpowers/sdd/progress.md`.
- Board: all four items **In progress**, annotated with the commit range. They stay open until their UI ships.

## What phase 0 gives the UI (consume verbatim)

- `vehicles` columns: `debris_option` 0/1, `debris_level` 0–100, `open_checkout` 0/1 (default 0 = owner-assigned closed), `locked_by` UUID|NULL (NULL = legacy lock).
- `vehicle_service_records`: `payer TEXT`, `job_id TEXT`; `createServiceRecord` accepts `payer`/`jobId`; a gas receipt = `type='fuel_up'` record (`FUEL_UP_TYPE`).
- `resolveLockStamp` in `src/components/vehicles/vehicleSessionLogic.ts` — already wired; locks stamp `locked_by` now.
- `src/db/gasReceiptPayers.ts`: `getGasReceiptPayers`/`setGasReceiptPayers` + subscribe/version/notify (hiddenFields pattern); default `['Teams','Office','Contents','Construction']` in code.
- Media: `entity_type='service_record'` accepted end-to-end (presign/save/list/sync).

## UI scope per item (from issues + phase-0 spec "out of scope")

- **#152**: hide water/waste tank controls when no truck mount; `debris_option` toggle (mirror truck_mount placement in VehicleEditSheet); vertical drag-to-fill 0–100 debris selector in VehiclePanel (web-safe, no native module).
- **#155**: checkout list shows unowned vehicles + owned vehicles with `open_checkout=1`; owner opt-in toggle (VehicleEditSheet or panel); interplay with existing `checkout_locked` hard guard.
- **#167**: unlock rule = `canManageVehicle AND (effectiveTier(me) >= effectiveTier(locker) OR locked_by === me OR locked_by IS NULL)`; lock pill shows "locked by <name>"; keep `isCheckoutLockedFor`/`canManageVehicle` duplicate logic in sync (queries/access.ts:341, queries/vehicles.ts:336).
- **#168**: gas-receipt form on vehicle page — photo (media pipeline, `service_record` entity), payer REQUIRED (from `getGasReceiptPayers`), vehicle defaults to `getActiveCheckoutForUser`, changing it while checked out is allowed but logged (activity_log note), mileage (odometer), optional job (existing job selector); settings editor for the payer list (`system_settings`-gated, hidden-fields screen pattern). REUSE the kit: FormScreen/ModalSheet/SearchablePicker (user directive — hand-rolled surfaces caused #163).

## OPEN QUESTION (was being asked when we stopped)

Work structure — user was about to clarify. Options presented:
1. **Two waves (recommended)**: #152+#155+#167 panel/checkout tweaks on one branch, then #168 gas receipts on its own branch.
2. All four on one branch.
3. One item at a time.
Resume by asking what they wanted to clarify, then settle this, then brainstorm the per-item design questions (drag-control interaction, opt-in toggle placement, receipt form layout) → spec → plan → build.

## Session mode + gotchas

- User directive: implement **together in main session**, subagents ONLY for research/documenting.
- Metro is serving the main checkout (now on `main`); create a feature branch before touching code. Hotload after each phase (CLAUDE.md).
- Deploy lockstep: next API ship auto-applies 065/066; `open_checkout=false` drops owned vehicles from others' checkout lists that day — warn the crew.
- Unrelated dirty files in tree: `.claude/skills/board/*` edits + untracked `.claude/skills/start-metro/` — never `git add -A`.
