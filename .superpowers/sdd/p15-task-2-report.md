# Task 2 Report — Equipment unit lock, Category, Returnable

## Files modified
- `apps/mobile/app/(app)/(inventory)/add.tsx`
- `apps/mobile/app/(app)/(inventory)/[id].tsx`

---

## Step 1 — Equipment unit lock (add.tsx)

Renamed the existing unit-category state from `category` → `unitCat` / `setUnitCat` to free the name for the new item-category field.

Added a `useEffect([kind])` that fires whenever the kind toggle changes:
- `equipment` → calls `setUnitCat('piece')` + `setUnit('each')` + `setReturnable(true)`
- `product` → calls `setReturnable(false)` (leaves unitCat/unit for the user to pick)

In JSX, the Units section is now conditional on `kind`:
- `equipment`: renders a single read-only `<Text>Unit: each (piece)</Text>`; the CATEGORIES selector and unit chip row are hidden
- `product`: renders the original CATEGORIES list + UNIT_OPTIONS chip row as before

`clearForm` resets `unitCat` to `'piece'` and `unit` to `'each'` (new names).

In `[id].tsx` (edit mode), a read-only notice `"Unit: each (piece) — fixed for equipment"` is shown when `item.kind === 'equipment'`. Since the detail-edit form has never had unit pickers, this serves as explicit confirmation rather than needing to hide anything.

---

## Step 2 — Category field

**add.tsx:** Added `const [category, setCategory] = useState('')` and `const categoryOptions = useMemo(() => getDistinctValues('category'), [])`. A `SuggestInput` labeled "Category" with `suggestions={categoryOptions}` and placeholder "Air Movers, Filters, Equipment Inventory…" is rendered between the Model/Color field and the Returnable switch.

Payload changes replacing the Task-1 stopgap `category: null`:
- `upsertItem({ ..., category: category.trim() || null })` — local SQLite
- `appendOutbox('INSERT', 'inventory_items', { ..., category: category.trim() || null })` — outbox

**[id].tsx:** Added `const [editCategory, setEditCategory] = useState('')` (separate from the `form` Record to avoid string-coercion issues). Initialized in `startEdit()` from `item.category ?? ''`. Edit mode renders a `SuggestInput label="Category"` bound to `editCategory`. Saved in `fields.category = editCategory.trim() || null` → `updateItemFields`. View mode shows a `<Row k="Category" v={item.category} />` (hidden when null).

---

## Step 3 — Returnable toggle

**add.tsx:** Added `const [returnable, setReturnable] = useState(false)`. The `useEffect([kind])` sets the default: equipment → `true`, product → `false`; user can override after that. A `<Switch value={returnable} onValueChange={setReturnable} />` with label is rendered.

Payload handling:
- `upsertItem({ ..., returnable: returnable ? 1 : 0 })` — op-sqlite binds only number, so 0/1
- `appendOutbox('INSERT', 'inventory_items', { ..., returnable })` — spreads payload (which has number) then overrides with the boolean `returnable`; JSON.stringify sends `true`/`false` to the server where the column is `BOOLEAN`

**[id].tsx:** Added `const [editReturnable, setEditReturnable] = useState(false)`, initialized in `startEdit()` as `item.returnable === 1`. Edit mode renders a `<Switch value={editReturnable} onValueChange={setEditReturnable} />`. Saved as:
- `fields.returnable = editReturnable ? 1 : 0` → `updateItemFields` (SQLite number)
- `appendOutbox('UPDATE', ..., { ...synced, returnable: editReturnable })` — boolean override for Postgres

View mode shows a color badge: green "Returnable" when `item.returnable` is truthy, red "Consumed" otherwise.

---

## Stopgap replacements confirmed

| Location | Was | Now |
|---|---|---|
| `add.tsx` upsertItem | `category: null` | `category: category.trim() \|\| null` |
| `add.tsx` upsertItem | `returnable: 0` | `returnable: returnable ? 1 : 0` |
| `add.tsx` appendOutbox INSERT | `returnable: 0` (implicit via `...payload`) | `returnable` (boolean) via override |

---

## tsc result

`npx tsc --noEmit -p tsconfig.json` — **exit 0, no errors or warnings.**

---

## On-device verification pending

All behaviors require a physical device to verify:
- Equipment kind toggle → unit locks to "each (piece)", pickers hidden
- Product kind toggle → full unit-category + chip row appears
- Returnable switch defaults correctly per kind, toggleable by user
- Category SuggestInput autocompletes from existing catalog values
- Saved items show Category row and Returnable/Consumed badge in detail view
- Edit mode initializes Category and Returnable from existing item data

**On-device testing is needed from the human** (Pixel 10 Pro XL via USB tunnel per the project CLAUDE.md).

---

## Commit

`fe9c70d` — `feat(inventory): equipment pieces + Category + Returnable on add/edit`
