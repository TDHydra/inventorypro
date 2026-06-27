# Simple/Detailed Form Mode — Design Spec

*Date: 2026-06-27 · Branch: `feat/form-mode` · Program Phase 3c of the Settings program (3a/3b done)*

## Context

The entry forms (item add, location create, job create, equipment) carry many optional/advanced
fields. Field crews want a stripped-down form; managers want the full one. Phase 3c adds a
**Simple/Detailed** form mode: in **Simple**, each form hides its optional fields behind a per-form
"Show advanced fields" expander; in **Detailed**, everything shows. This is the last phase of the
Settings program (3a settings core, 3b maintenance mode, both shipped).

### Decisions locked with the user
- **Control model:** admin sets an app-wide **default** (synced); each user can set a **local override**
  on their device. Override wins; if neither is set, fall back to **Detailed** (nothing hides unexpectedly).
- **Simple behavior:** optional fields are hidden but revealable inline per-entry via a
  **"⌄ Show advanced fields"** expander — no need to leave Simple mode for a one-off field.
- **No migration / no native:** reuses the Phase-3b synced `app_config` table and the polish-pass
  `app_settings` generic helpers.

## Global Constraints

- Expo SDK 56 — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- op-sqlite bind params: only `string | number | null | ArrayBuffer`.
- **No DB migration, no native module, no new permission.** Admin setter gated on the existing tier-4
  `system_settings` permission (same gate as maintenance mode).
- **Synced default** rides the existing `app_config` table (Phase 3b) — set it exactly like
  `setMaintenanceMode` (`setAppConfigLocal` + `appendOutbox('INSERT','app_config',…)`). **User override**
  is local-only in `app_settings` (never synced), via `getAppSetting`/`setAppSetting` (polish pass).
- TypeScript gate only (no unit-test runner): `npx tsc --noEmit` clean (mobile) + manual check.

## Shared Context Pack

- **Synced config (3b):** `src/db/appConfig.ts` `getAppConfig(key)`, `setAppConfigLocal(key,value)`;
  `src/db/maintenance.ts` `setMaintenanceMode` shows the write-local-then-push pattern (`appendOutbox('INSERT','app_config',{key,value,updated_at})`). `app_config` already in the sync allowlists.
- **Local prefs (polish):** `src/db/appSettings.ts` `getAppSetting(key): string | null`, `setAppSetting(key,value)`.
- **Tier / gating:** `src/constants/roles.ts` `ROLE_TIER` (tier-4 = `full_admin`/`franchise_manager`);
  Settings uses `usePermission('system_settings')` (tier-4-exclusive) for admin-only rows.
- **Settings screen:** `app/(app)/(admin)/settings.tsx` — has the maintenance toggle (tier-4 gated) +
  idle/account/sync/app-info sections + a focus-refresh `useFocusEffect`. New rows slot in here.
- **`useMaintenanceMode` hook** (`src/hooks/useMaintenanceMode.ts`) is the pattern to mirror for
  `useFormMode` (read on mount + `useFocusEffect`).
- **Forms to wire** (each already migrated to the polish primitives — `FieldLabel`/`AppInput`/`Card`):
  - `app/(app)/(jobs)/create.tsx` — fields: Job Name* | Customer Name, Site Address, Site Location, Description.
  - `app/(app)/(inventory)/add.tsx` — Item, Location, Quantity* | Barcode, Description, Supplier, Model,
    Category, Min-qty alert, Reorder-to, Tag prefix (+ the equipment-only unit-tracked/tag-prefix group).
  - `app/(app)/(locations)/index.tsx` (create modal) — Name* | Parent ("Inside"), Owner ("Belongs to"),
    GPS Anchor, Icon, Color.
  - `app/(app)/(inventory)/[id].tsx` equipment add/edit + `EquipmentQuickAdd` — Asset Tag* | Serial #, Notes.

---

## Architecture (5 units)

### Unit 1 — Form-mode resolution (`src/db/formMode.ts`)
```ts
export type FormMode = 'simple' | 'detailed';

// Resolution: user local override wins → admin synced default → 'detailed'.
export function getFormMode(): FormMode {
  const override = getAppSetting('form_mode_override');           // 'simple' | 'detailed' | null
  if (override === 'simple' || override === 'detailed') return override;
  const def = getAppConfig('form_mode_default');                  // 'simple' | 'detailed' | null
  return def === 'simple' ? 'simple' : 'detailed';
}

// Admin app-wide default (synced via app_config, like setMaintenanceMode).
export function getFormModeDefault(): FormMode { return getAppConfig('form_mode_default') === 'simple' ? 'simple' : 'detailed'; }
export function setFormModeDefault(mode: FormMode): void {
  setAppConfigLocal('form_mode_default', mode);
  appendOutbox('INSERT', 'app_config', { key: 'form_mode_default', value: mode, updated_at: new Date().toISOString() });
}

// User local override. null clears it ("use app default").
export function getFormModeOverride(): FormMode | null {
  const v = getAppSetting('form_mode_override');
  return v === 'simple' || v === 'detailed' ? v : null;
}
export function setFormModeOverride(mode: FormMode | null): void {
  if (mode == null) { /* clear: write empty / delete row */ setAppSetting('form_mode_override', ''); }
  else setAppSetting('form_mode_override', mode);
}
```
(Clearing the override writes `''`, which `getFormModeOverride` treats as "unset". A dedicated delete is
unnecessary — the empty string is the sentinel.)

### Unit 2 — `useFormMode` hook (`src/hooks/useFormMode.ts`)
Mirrors `useMaintenanceMode`: returns `{ mode, isSimple }`, reads on mount + re-reads on `useFocusEffect`
so a change in Settings (or a synced default arriving) reflects when the user returns to a form.

### Unit 3 — `<AdvancedFields>` primitive (`src/components/ui/AdvancedFields.tsx`)
```tsx
// Wraps a form's optional fields. Detailed → always rendered. Simple → collapsed behind a
// "Show advanced fields" toggle (local state, default collapsed) revealable inline.
export function AdvancedFields({ children }: { children: React.ReactNode }) {
  const { isSimple } = useFormMode();
  const [open, setOpen] = useState(false);
  if (!isSimple) return <>{children}</>;
  return (
    <View>
      <TouchableOpacity onPress={() => setOpen(o => !o)} style={...}>
        <Text style={{ color: colors.primaryText }}>{open ? '⌃ Hide advanced fields' : '⌄ Show advanced fields'}</Text>
      </TouchableOpacity>
      {open && <View>{children}</View>}
    </View>
  );
}
```
Uses theme tokens. One wrapper per form's optional group; the primitive owns the mode check + expander.

### Unit 4 — Settings UI (`app/(app)/(admin)/settings.tsx`)
- **Admin (tier-4, `usePermission('system_settings')`) — "Default form mode":** Simple / Detailed selector
  → `setFormModeDefault` (synced). Subtext: "Applies to all devices unless a user overrides it."
- **Everyone — "Form detail (this device)":** Simple / Detailed / **Use app default** selector →
  `setFormModeOverride(mode | null)` (local). Shows the resolved effective mode.
- Both refresh via the screen's existing `useFocusEffect`.

### Unit 5 — Wire the forms
Wrap each form's optional field group(s) in `<AdvancedFields>`, leaving the essentials above it:

| Form | Essential (always) | Wrapped in `<AdvancedFields>` |
|---|---|---|
| `jobs/create.tsx` | Job Name | Customer Name, Site Address, Site Location, Description |
| `inventory/add.tsx` | Item, Location, Quantity | Barcode, Description, Supplier, Model, Category, Min-qty alert, Reorder-to, Tag prefix (+ unit-tracked group) |
| `locations/index.tsx` (create) | Name | Parent, Owner, GPS Anchor, Icon, Color |
| `inventory/[id].tsx` equip + `EquipmentQuickAdd` | Asset Tag | Serial #, Notes |

Quick-add Item/Location/Stock sub-forms are already the rapid-entry tool; apply `<AdvancedFields>` only
where they have a clear optional group (Item: supplier/model/category/min-qty; Location: icon/color/owner)
— keep their fast flow intact. Checkout/checkin wizards are out of scope (step flows, not field forms).

---

## File map
| Unit | Files |
|---|---|
| 1 | `src/db/formMode.ts` (new) |
| 2 | `src/hooks/useFormMode.ts` (new) |
| 3 | `src/components/ui/AdvancedFields.tsx` (new) |
| 4 | `app/(app)/(admin)/settings.tsx` |
| 5 | `app/(app)/(jobs)/create.tsx`, `app/(app)/(inventory)/add.tsx`, `app/(app)/(locations)/index.tsx`, `app/(app)/(inventory)/[id].tsx`, `src/components/quickadd/{Item,Location}QuickAdd.tsx` |

## Verification
- `tsc --noEmit` clean.
- Detailed mode (default): every form shows all fields, no expander.
- Admin sets Default = Simple → second device pulls `app_config.form_mode_default` → its forms collapse
  optional fields behind the expander; tapping "Show advanced fields" reveals them inline.
- User override = Detailed on a device where the admin default is Simple → that device shows everything
  (override wins); "Use app default" clears the override → reverts to Simple.
- The synced default propagates (it's an `app_config` upsert, exactly like maintenance mode).

## Out of scope
- Per-field admin configuration of *which* fields are advanced (the classification is fixed in code here);
  a runtime field-visibility editor is a future backlog item.
- Conditional Owner field (backlog) — when built, it governs Owner visibility regardless of form mode.
- Checkout/checkin wizards; the dashboard.
