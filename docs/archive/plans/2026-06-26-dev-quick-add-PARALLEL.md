# Dev Quick-Add Tool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`. **Verification gate:** no unit-test runner in this RN/Expo app — the gate per task is `npx tsc --noEmit` clean (controller, app-wide) + the task's manual check. Implementer agents do **NO git and NO tsc**; the controller runs unified tsc, commits per task, reviews.

**Goal:** An admin-only Quick-Add utility (rapid "save & add another" forms for Items, Locations, Equipment units, and Stock quantities) hosted on a now-real Settings screen, writing through the normal local-SQLite + outbox path.

**Architecture:** A new gated `quick-add.tsx` screen with a 4-way segmented control; each mode is a focused sub-component in `src/components/quickadd/` that reuses existing query helpers + `appendOutbox` + `appendLog`. The `Settings` stub becomes a real screen linking to it. JS-only — no migration, no native module (ships over Metro).

**Tech Stack:** Expo SDK 56, expo-router, `@op-engineering/op-sqlite`.

## Global Constraints

- Expo SDK 56 — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- op-sqlite bind params: only `string | number | null | ArrayBuffer`; booleans `0/1` locally, **real booleans** in outbox payloads (e.g. `active: true`).
- `appendLog` self-enqueues its own `activity_log` outbox row — never separately outbox an activity_log row.
- No new migration, no native module, no new permission. Gate on existing `system_settings` permission, enforced on BOTH the Settings entry AND the screen (deep-link safe).
- Reuse existing helpers; don't duplicate insert logic.
- Full Shared Context Pack (helper signatures) is in the spec: `docs/superpowers/specs/2026-06-26-dev-quick-add-design.md` — both task briefs ship with it.

## Write recipes (exact, per mode — copy verbatim)
All use `generateUUID()` (`src/utils/uuid`), `new Date().toISOString()` for `now`, and `useSession().user` for `user_id`.
- **Item:** `const item = { id, name, barcode:null, description:null, sku:null, supplier:null, model:null, kind, category: category||null, returnable:0, unit_tracked: isEquipment&&unitTracked?1:0, tag_prefix: tagPrefix||null, unit_category, unit, min_qty_alert:0, reorder_to:null, active:1, updated_at:now };`
  `upsertItem(item); appendOutbox('INSERT','inventory_items', { ...item, returnable: !!item.returnable, unit_tracked: !!item.unit_tracked, active:true }); appendLog({ action:'item_created', entity_type:'item', entity_id:id, user_id:user.id, team_id:null, from_location_id:null, to_location_id:null, quantity:null, unit:null, job_id:null, note:name, metadata:null, device_id:null });`
- **Location:** `const loc = { id, name, parent_id: parentId||null, color: DEFAULT_COLOR, icon: DEFAULT_ICON, owner_user_id:null, active:1, updated_at:now };`
  `upsertLocation(loc); appendOutbox('INSERT','locations', { ...loc, active:true }); appendLog({ action:'location_created', entity_type:'location', entity_id:id, user_id:user.id, note:name, ...nulls });`
- **Equipment unit:** validate `getUnitByTag(tag)===null` first (else inline error). `const u = { id, item_id, asset_tag:tag, serial_number: serial||null, status:'available', current_location_id:null, current_job_id:null, notes:null, created_at:now, updated_at:now };`
  `upsertUnit(u); appendOutbox('INSERT','equipment_units', { ...u }); appendLog({ action:'add_units', entity_type:'equipment_unit', entity_id:id, user_id:user.id, note:tag, ...nulls });`
- **Stock:** `adjustStock(itemId, locationId, qty); const abs = getStockQuantity(itemId, locationId); appendOutbox('UPDATE','stock_by_location', { item_id:itemId, location_id:locationId, quantity:abs, updated_at:now }); appendLog({ action:'add_stock', entity_type:'item', entity_id:itemId, to_location_id:locationId, quantity:qty, unit:item.unit, user_id:user.id, team_id:null, from_location_id:null, job_id:null, note:null, metadata:null, device_id:null });`

---

### Task 1: Quick-Add screen (4 modes) + ActionIcons

**Files:**
- Create: `apps/mobile/app/(app)/(admin)/quick-add.tsx` (shell)
- Create: `apps/mobile/src/components/quickadd/ItemQuickAdd.tsx`, `LocationQuickAdd.tsx`, `EquipmentQuickAdd.tsx`, `StockQuickAdd.tsx`
- Modify: `apps/mobile/src/components/ActivityFeed.tsx` (add `item_created` to `ACTION_ICONS`)

**Interfaces — Produces:**
- Route `/(app)/(admin)/quick-add`.
- Mode-component contract: each `*QuickAdd` is `({ onSaved }: { onSaved: (label: string) => void }) => JSX` — it owns its form + write, and calls `onSaved(humanLabel)` after a successful save (the shell bumps the counter + shows the confirmation).

- [ ] **Step 1: shell `quick-add.tsx`.** Gate at top: `const canDev = usePermission('system_settings'); if (!canDev) return <NotAuthorized/>;` (a small inline view + a back button — deep-link safe). A segmented control (`Item · Location · Equipment · Stock`) in local state `mode`; a session counter `useState<Record<string,number>>({})`; `onSaved = (label) => { setCount(c => ({...c, [mode]: (c[mode]??0)+1 })); showToast(\`Added ${label}\`); }`. Render the active mode component passing `onSaved`. Show "Added N this session" for the current mode. `Stack.Screen` title "Quick Add".
- [ ] **Step 2: `ItemQuickAdd.tsx`.** Form: name (req, autoFocus), kind toggle (product/equipment), unit_category (default `'piece'`) + unit (default `'each'`) inputs, optional category; when kind=equipment show unit_tracked toggle + tag_prefix. "Save & add another" → validate name non-empty → run the **Item write recipe** → `onSaved(name)` → clear fields (keep nothing sticky) → refocus name. "Done" → `router.back()`. Inline error if name empty.
- [ ] **Step 3: `LocationQuickAdd.tsx`.** Form: name (req, autoFocus), optional parent via `SearchablePicker` (options from `getTopLevelLocations()` mapped to `{id,label}`). Defaults `DEFAULT_COLOR='#1E3A5F'`, `DEFAULT_ICON='📦'`. Save → **Location recipe** → `onSaved(name)` → clear name (**keep parent sticky**) → refocus name.
- [ ] **Step 4: `EquipmentQuickAdd.tsx`.** Form: item via `SearchablePicker` (options = `searchItems('',100).filter(i => i.unit_tracked === 1)` mapped to `{id,label,sublabel: i.tag_prefix ?? ''}`), asset_tag (req, autoFocus), optional serial. On save: if `getUnitByTag(tag.trim())` is non-null → inline "Tag already used", abort. Else **Equipment recipe** → `onSaved(tag)` → clear tag+serial (**keep item sticky**) → refocus tag. Disable save until an item is selected.
- [ ] **Step 5: `StockQuickAdd.tsx`.** Form: location via `SearchablePicker` (`getAllLocations()` → `{id,label}`), item via `SearchablePicker` (`searchItems('',100)` → `{id,label,sublabel:i.unit}`), quantity (numeric `keyboardType="decimal-pad"`). Save → validate qty>0 and both selected → **Stock recipe** (look up `item` from the selected option for `item.unit`) → `onSaved(\`${qty} ${item.unit} @ ${locName}\`)` → clear item+qty (**keep location sticky**) → refocus item/qty. Inline error on qty≤0.
- [ ] **Step 6: ActionIcons.** In `src/components/ActivityFeed.tsx`, add `item_created` to `ACTION_ICONS` with a glyph (e.g. `'🆕'`).
- [ ] **Step 7 (controller): verify.** `cd apps/mobile && npx tsc --noEmit` clean. (Manual on device: each mode saves, counter bumps, sticky selection holds, rows appear in their lists.)
- [ ] **Step 8 (controller): commit** `feat(admin): quick-add screen — rapid Item/Location/Equipment/Stock entry`.

### Task 2: Settings host screen

**Files:** Modify `apps/mobile/app/(app)/(admin)/settings.tsx` (replace the stub)
**Consumes:** Task 1's route `/(app)/(admin)/quick-add`; `usePermission('system_settings')`.
- [ ] **Step 1:** Replace the "coming soon" stub with a real minimal Settings screen: a `ScrollView` with an app-info line (e.g. app name + "InventoryPro"), and — only when `usePermission('system_settings')` — a **"Developer tools"** section containing a **"⚡ Quick Add"** row (TouchableOpacity) → `router.push('/(app)/(admin)/quick-add')`. Non-admins see Settings without the dev section (no crash). Keep `Stack.Screen` title "Settings". Match existing admin-screen styling.
- [ ] **Step 2 (controller): verify** `npx tsc --noEmit` clean; manual: admin sees + can open Quick Add; non-admin doesn't see the section.
- [ ] **Step 3 (controller): commit** `feat(admin): real Settings screen hosting the Quick-Add dev tool`.

---

# SHIP (controller, after both tasks merge)
- [ ] App-wide `npx tsc --noEmit` (mobile) clean; whole-branch review (opus) vs spec.
- [ ] Merge `feat/dev-quick-add` → `main`.
- [ ] **No prod API redeploy / no dev-client rebuild needed** (JS-only, no migration, no native). The change reaches the dev client via Metro reload; rebuild the **release APK** for standalone.

## Self-Review (controller checklist)
- **Spec coverage:** Unit1 (Settings host)→T2; Unit2 (shell+gate+counter)→T1 step1; Unit3 (4 forms)→T1 steps2-5; logging/ActionIcons→T1 step6; sync via recipes (outbox+log) in every mode. ✔
- **Placeholder scan:** the write recipes are literal; "NotAuthorized" / "showToast" are shell helpers the implementer defines (described), not external TODOs.
- **Type consistency:** mode-component contract `{onSaved:(label:string)=>void}` consistent across T1 steps; `InventoryItem`/`Location`/`EquipmentUnit` shapes match the recipes; `appendOutbox` real-boolean rule applied (item/location `active:true`, item `returnable`/`unit_tracked` booleans).
- **File-collision check:** T1 = quick-add.tsx + quickadd/* + ActivityFeed.tsx; T2 = settings.tsx. Disjoint. (T1 and T2 could even run in parallel — T2's `router.push` to T1's route is a runtime string, not a compile dependency.)
