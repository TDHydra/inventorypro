# Simple/Detailed Form Mode (Phase 3c) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or an ultramode Workflow). **Verification gate:** no unit-test runner — gate per task is `npx tsc --noEmit` clean (mobile) + the task's manual check. Implementers do NO git / NO tsc; the controller runs tsc, commits explicit paths, reviews.

**Goal:** A Simple/Detailed form mode — admin sets an app-wide default (synced), each user can override locally; in Simple mode each form hides its optional fields behind a "Show advanced fields" expander.

**Architecture:** A `formMode.ts` resolver (user override → admin synced default → Detailed) + `useFormMode` hook + an `<AdvancedFields>` collapsible primitive; Settings gets two selectors; each form wraps its optional field group in `<AdvancedFields>`. Reuses the Phase-3b `app_config` table and polish-pass `app_settings` helpers — no migration, no native.

**Tech Stack:** Expo SDK 56, expo-router, op-sqlite.

## Global Constraints
- Expo SDK 56; op-sqlite bind params only `string|number|null|ArrayBuffer`.
- **No DB migration, no native module, no new permission.** Admin setter gated on existing tier-4 `system_settings`.
- Synced default rides existing `app_config` (set like `setMaintenanceMode`: `setAppConfigLocal` + `appendOutbox('INSERT','app_config',{key,value,updated_at})`). User override local-only in `app_settings` via `getAppSetting`/`setAppSetting`.
- Resolution precedence: user override (`form_mode_override`) → admin default (`form_mode_default`) → `'detailed'`. Override sentinel `''` = unset.
- TypeScript gate only: `npx tsc --noEmit` clean (mobile) per task.
- **Full spec (carries the exact code): `docs/superpowers/specs/2026-06-27-form-mode-design.md`** — every brief ships with it.

---

# WAVE 0 — Foundation (T1; everything else depends on it)

### Task 1: formMode resolver + useFormMode hook + AdvancedFields primitive
**Files:** Create `apps/mobile/src/db/formMode.ts`, `apps/mobile/src/hooks/useFormMode.ts`, `apps/mobile/src/components/ui/AdvancedFields.tsx`
**Produces (consumed by all later tasks):**
- `formMode.ts`: `type FormMode='simple'|'detailed'`; `getFormMode(): FormMode`; `getFormModeDefault(): FormMode`; `setFormModeDefault(mode: FormMode): void`; `getFormModeOverride(): FormMode|null`; `setFormModeOverride(mode: FormMode|null): void`.
- `useFormMode.ts`: `useFormMode(): { mode: FormMode; isSimple: boolean }`.
- `AdvancedFields.tsx`: `AdvancedFields({ children }: { children: React.ReactNode })`.

- [ ] **Step 1:** Create the three files using the exact code in the spec's Units 1–3. `formMode.ts` imports `getAppSetting`/`setAppSetting` from `../db/appSettings`, `getAppConfig`/`setAppConfigLocal` from `./appConfig`, `appendOutbox` from `../sync/outbox`. `useFormMode.ts` mirrors `useMaintenanceMode.ts` (read on mount + `useFocusEffect` re-read). `AdvancedFields.tsx` uses `useFormMode` + theme tokens; Detailed → renders children directly; Simple → "⌄ Show advanced fields" toggle (local `useState`, default collapsed) revealing children.
- [ ] **Step 2 (controller): verify** `npx tsc --noEmit` clean.
- [ ] **Step 3 (controller): commit** `feat(forms): form-mode resolver + useFormMode + AdvancedFields`.

---

# WAVE 1 — Settings UI + form wiring (T2–T6, file-disjoint, parallel after T1)

**Each form-wiring task** imports `<AdvancedFields>` from `../../../src/components/ui/AdvancedFields` (adjust depth) and wraps that form's optional field group(s) — listed below — in a single `<AdvancedFields>…</AdvancedFields>`, leaving the essential fields above it. READ the file first; move ONLY the JSX of the optional fields inside the wrapper; change no logic, validation, or state. Detailed mode renders identically to today; Simple collapses the wrapped group.

### Task 2: Settings — form-mode selectors
**Files:** Modify `apps/mobile/app/(app)/(admin)/settings.tsx`
**Consumes:** `getFormModeDefault`/`setFormModeDefault`/`getFormModeOverride`/`setFormModeOverride`/`getFormMode` (T1).
- [ ] **Step 1:** Add imports from `../../../src/db/formMode`. Add a **tier-4 "Default form mode"** row inside the existing `{isTier4 && (…)}` System section (a Simple/Detailed selector → `setFormModeDefault`, subtext "Applies to all devices unless a user overrides it"). Add an **all-users "Form detail (this device)"** section (its own `<View>`/`s.card`, NOT gated) with a Simple / Detailed / **Use app default** selector → `setFormModeOverride('simple'|'detailed'|null)`, showing the resolved `getFormMode()`. Use the screen's existing `useFocusEffect`/`refreshStatus` to re-read state. Style with the existing `s.sectionTitle`/`s.card`/`s.row` + theme tokens (selector can mirror the idle-timeout selector pattern already in the file).
- [ ] **Step 2 (controller): verify** clean. **Step 3 (controller): commit** `feat(settings): Simple/Detailed form-mode selectors`.

### Task 3: Jobs create form
**Files:** Modify `apps/mobile/app/(app)/(jobs)/create.tsx`
- [ ] **Step 1:** Wrap **Customer Name, Site Address, Site Location, Description** in `<AdvancedFields>`. Leave **Job Name** above it. **Step 2/3 (controller):** verify clean; commit `feat(forms): jobs create — advanced fields`.

### Task 4: Inventory add form
**Files:** Modify `apps/mobile/app/(app)/(inventory)/add.tsx`
- [ ] **Step 1:** Keep **Item, Location, Quantity** essential. Wrap the optional group — **Barcode, Description, Supplier, Model, Category, Min-qty alert, Reorder-to, Tag prefix** (and the equipment-only unit-tracked/tag-prefix sub-group) — in `<AdvancedFields>`. (If a field is interleaved with essentials, keep the wrapper around the contiguous optional block; do not reorder essentials.) **Step 2/3 (controller):** verify clean; commit `feat(forms): inventory add — advanced fields`.

### Task 5: Locations create modal
**Files:** Modify `apps/mobile/app/(app)/(locations)/index.tsx`
- [ ] **Step 1:** In the create modal, keep **Name** essential; wrap **Parent ("Inside"), Owner ("Belongs to"), GPS Anchor, Icon, Color** in `<AdvancedFields>`. **Step 2/3 (controller):** verify clean; commit `feat(forms): locations create — advanced fields`.

### Task 6: Equipment + quick-add forms
**Files:** Modify `apps/mobile/app/(app)/(inventory)/[id].tsx`, `apps/mobile/src/components/quickadd/ItemQuickAdd.tsx`, `apps/mobile/src/components/quickadd/LocationQuickAdd.tsx`
- [ ] **Step 1:** `inventory/[id].tsx` equipment add/edit: keep **Asset Tag** essential, wrap **Serial #, Notes** in `<AdvancedFields>`. `ItemQuickAdd`: keep name/unit essential, wrap the optional group (supplier/model/category/min-qty) in `<AdvancedFields>`. `LocationQuickAdd`: keep name essential, wrap icon/color/owner in `<AdvancedFields>`. (`StockQuickAdd`/`EquipmentQuickAdd` rapid flow unchanged unless a clear optional group exists.) Import depth: `[id].tsx` → `../../../src/components/ui/AdvancedFields`; quickadd → `../ui/AdvancedFields`. **Step 2/3 (controller):** verify clean; commit `feat(forms): equipment + quick-add — advanced fields`.

---

# SHIP (controller, after all tasks)
- [ ] Mobile-wide `npx tsc --noEmit` clean; whole-branch review (opus, `merge-base..HEAD`).
- [ ] Merge `feat/form-mode` → `main`. JS-only (no migration/native) → reaches dev client via Metro; rebuild the **release APK**.
- [ ] Manual: Detailed (default) shows all fields. Admin sets Default=Simple → forms collapse optional fields behind the expander; tap reveals inline. User override=Detailed wins on that device; "Use app default" clears it. Synced default propagates (app_config upsert).

## Self-Review (controller checklist)
- **Spec coverage:** U1→T1; U2 (useFormMode)→T1; U3 (AdvancedFields)→T1; U4 (Settings)→T2; U5 (form wiring)→T3–T6. ✔
- **Type consistency:** `useFormMode(): {mode,isSimple}`, `AdvancedFields({children})`, the four formMode setters/getters — defined T1, consumed T2–T6 verbatim.
- **File-collision:** T1 = 3 new files; T2 = settings.tsx; T3 = jobs/create; T4 = inventory/add; T5 = locations/index; T6 = inventory/[id] + 2 quickadd. All disjoint → T2–T6 parallel after T1. ✔
- **No migration/native:** reuses app_config + app_settings; admin gate is existing tier-4. ✔
