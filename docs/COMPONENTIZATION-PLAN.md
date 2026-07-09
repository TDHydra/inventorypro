# Componentization Plan — app-wide reusable inputs

**Goal.** Stop hand-wiring the same picker/field/list glue on every screen. Extract a small set of
drop-in components so adding a field (e.g. an item-name field) is one line, and dynamic inputs behave
identically everywhere.

**Measured duplication** (`apps/mobile`, counted 2026-07-08):

| Pattern | Consumer files | Status |
| --- | --- | --- |
| `SearchablePicker` used directly | 20 | primitive is good; the **wiring around it** is copy-pasted |
| Taxonomy wiring (`getTaxonomyTypes*` + `useMemo` + `SearchablePicker`) | 15 | **the big one** |
| `ModalSheet` | 17 | body layout re-implemented each time |
| `FilterChip` | 18 | chip rows + filter state re-implemented each time |
| `AppInput` | 22 | already healthy — leave alone |
| raw `<TextInput>` outside `components/` | 9 | migrate to `AppInput` opportunistically |

**Root cause.** We extracted the *primitives* (`SearchablePicker`, `ModalSheet`, `FilterChip`,
`AppInput`, `FieldLabel`) but never the *compositions*. Every screen re-derives options, re-maps to
`PickerOption`, re-holds selection state, and re-renders the same `<View style={s.fieldWrap}>` wrapper.

---

## The repeated block (verbatim, `app/(app)/(jobs)/create.tsx:46-51` + `:250-256`)

```tsx
const jobTypes = useMemo(() => getTaxonomyTypesWithFallback('job'), []);
const [type, setType] = useState<string | null>(() => {
  const ts = getTaxonomyTypes('job');
  return ts[0]?.label ?? null;
});
// …150 lines later…
<View style={s.fieldWrap}>
  <FieldLabel>Site Location</FieldLabel>
  <SearchablePicker
    placeholder="Search locations..."
    options={locationOptions}
    value={siteLocation}
    onSelect={opt => setSiteLocation(prev => prev?.id === opt.id ? null : opt)}
  />
</View>
```

This exact shape appears, with only the taxonomy category changed, in `(jobs)/create.tsx`,
`(jobs)/[id].tsx`, `(jobs)/index.tsx`, `(inventory)/add.tsx`, `(inventory)/[id].tsx`,
`(inventory)/index.tsx`, `(locations)/index.tsx`, `(locations)/[id].tsx`, `(repairs)/new.tsx`,
`(repairs)/[id].tsx`, `(repairs)/index.tsx`, `(equipment)/[id].tsx`, `(teams)/index.tsx`,
`(teams)/[id].tsx`, and the `quickadd/*` sheets.

---

## Sequencing constraint — read this first

Two other workstreams touch the same files:

1. **The scroll/layout audit** will likely change `SearchablePicker` (dropdown scroll) and `ModalSheet`
   (long option lists). Those are *inside* the primitives this plan wraps.
   → **Land the shared-component scroll fixes BEFORE Wave 1.** Wrapping a broken dropdown just
   propagates the bug behind a nicer name.
2. **#74 taxonomy FK cutover.** Entities now carry both a label cache (`type`) and a soft-FK
   (`type_id`). Screens are mid-migration: some hold the **label** in state (`(jobs)/create.tsx:47`),
   some hold the **id**. `TaxonomyPicker` must expose **both** and must not force a call site to change
   which one it persists — that is a separate migration, not this one.

---

## Wave 0 — Foundation (ONE agent, creates new files only)

Touches **no existing screen**. Additive, so nothing can regress. Must land and typecheck before Wave 1.

**Owns (all new):**
- `src/components/pickers/TaxonomyPicker.tsx`
- `src/components/pickers/LocationPicker.tsx`
- `src/components/pickers/UserPicker.tsx`
- `src/components/pickers/ItemPicker.tsx`
- `src/components/pickers/LocationShelfPicker.tsx`
- `src/components/pickers/index.ts` (barrel)
- `src/components/ui/Field.tsx`

### Required APIs

```tsx
// Field — the <View style={s.fieldWrap}><FieldLabel/>…</View> wrapper, once.
export function Field(props: { label: string; hint?: string; error?: string | null;
                               required?: boolean; children: React.ReactNode }): JSX.Element;

// TaxonomyPicker — replaces the 15 hand-rolled blocks.
// Exposes BOTH id and label (see #74 note above). `value` may be either; the component
// resolves whichever is supplied. onChange always reports both.
export function TaxonomyPicker(props: {
  category: 'job' | 'team' | 'location' | 'location_subtype' | 'item_category' | 'repair_status';
  valueId?: string | null;
  valueLabel?: string | null;
  onChange: (next: { id: string | null; label: string | null }) => void;
  label?: string;                 // renders inside <Field> when provided
  placeholder?: string;
  allowCreate?: boolean;          // surfaces SearchablePicker.onCreate
  defaultToFirst?: boolean;       // preserves today's `ts[0]?.label ?? null` behavior
  disabled?: boolean;
}): JSX.Element;

// LocationPicker — wraps getAllLocations() → PickerOption[]
export function LocationPicker(props: {
  value: PickerOption | null;
  onChange: (opt: PickerOption | null) => void;   // re-tapping the selection clears it
  label?: string; placeholder?: string;
  filter?: (l: Location) => boolean;              // e.g. only locations with has_shelves
  allowCreate?: boolean; disabled?: boolean;
}): JSX.Element;

// LocationShelfPicker — the backlog item. Renders LocationPicker, and reveals a shelf
// SearchablePicker ONLY when the chosen location has has_shelves = 1.
// Uses getShelvesForParent + findOrCreateShelf, and the existing {id:'__new__'} sentinel.
export function LocationShelfPicker(props: {
  locationValue: PickerOption | null;
  shelfValue: PickerOption | null;
  onChangeLocation: (opt: PickerOption | null) => void;
  onChangeShelf: (opt: PickerOption | null) => void;
  proximitySort?: boolean;    // pre-sort by useCurrentPosition + src/location/proximity
}): JSX.Element;

// UserPicker / ItemPicker — same shape. ItemPicker MUST use SearchablePicker's `searchFn`
// (query-per-keystroke), never a preloaded options array: the catalog is too large.
```

### Hard rules for the Wave-0 agent
- **Behavior-preserving.** `TaxonomyPicker` must reproduce today's defaults exactly, including
  `defaultToFirst` (`getTaxonomyTypes(cat)[0]?.label ?? null`) and the `getTaxonomyTypesWithFallback`
  fallback list. Read `src/db/queries/taxonomy.ts` before writing.
- **No new dependencies.** Compose `SearchablePicker`, `FieldLabel`, `AppInput`, `ModalSheet` only.
- **Web-safe.** No native-only imports (no `expo-location` at module scope — `proximitySort` must
  degrade to unsorted on web). This app also builds for Expo Web via sql.js.
- **Do not touch** `src/db/**`, `src/sync/**`, `apps/api/**`, or any file under `app/`.
- Ship a unit test for `TaxonomyPicker`'s id↔label resolution as a **pure helper** in
  `src/components/pickers/resolveTaxonomyValue.ts` (pure, DB-free — importing `taxonomy.ts` pulls in
  native op-sqlite and will not run under `node --test`). Mirror `src/db/queries/labelResolve.ts`.

**Verify:** `npx tsc --noEmit` → 0. `npm test` green. No file under `app/` modified (`git status`).

---

## Wave 1 — Swap the call sites (6 agents, strictly disjoint files)

Each agent owns one route group. **No two agents may open the same file.** Nobody edits
`src/components/**` in this wave — Wave 0 froze it.

| Agent | Owns (exclusive) |
| --- | --- |
| W1-jobs | `app/(app)/(jobs)/create.tsx`, `[id].tsx`, `index.tsx` |
| W1-inventory | `app/(app)/(inventory)/add.tsx`, `[id].tsx`, `index.tsx` |
| W1-locations | `app/(app)/(locations)/index.tsx`, `[id].tsx` |
| W1-repairs | `app/(app)/(repairs)/new.tsx`, `[id].tsx`, `index.tsx` |
| W1-teams-equip | `app/(app)/(teams)/index.tsx`, `[id].tsx`, `app/(app)/(equipment)/[id].tsx` |
| W1-quickadd | `src/components/quickadd/*.tsx` |

### Per-call-site recipe (give this verbatim to each agent)

1. Delete the local `useMemo(() => getTaxonomyTypesWithFallback('<cat>'), [])` and the
   `useState` initializer that reads `getTaxonomyTypes('<cat>')[0]`.
2. Replace the `<View style={s.fieldWrap}><FieldLabel>…</FieldLabel><SearchablePicker …/></View>`
   block with `<TaxonomyPicker category="<cat>" label="…" … />`.
3. **Keep persisting whatever the screen persists today.** If it wrote the label, keep writing the
   label (`onChange={v => setType(v.label)}`). If it wrote `type_id`, keep writing the id. Do **not**
   opportunistically migrate label→id here; that is #74 Phase 3, tracked separately.
4. Remove the now-unused imports (`getTaxonomyTypes`, `getTaxonomyTypesWithFallback`,
   `SearchablePicker`, `PickerOption`, `FieldLabel`) — but only if genuinely unused in that file.
5. Delete the orphaned `fieldWrap` style entry only if no other JSX in the file references it.

### Hard rules
- **Zero behavior change.** Same default selection, same clear-on-retap, same create-new affordance.
- If a call site does something the component cannot express, **stop and report it** rather than
  changing the screen's behavior to fit the component. That is a Wave-0 API gap, not a screen bug.
- `npx tsc --noEmit` → 0 before finishing. Do not run Metro, gradle, or git.

**Verify (on-device, after the wave merges):** open each screen, confirm the type dropdown shows the
same options in the same order, the default selection is unchanged, creating a new type still works,
and re-tapping a selected option still clears it.

---

## Wave 2 — Compositions (2 agents, after Wave 1 is green)

Higher risk; each replaces real logic, not just markup.

| Agent | Owns | Task |
| --- | --- | --- |
| W2-list | `src/components/ui/ListScreenShell.tsx` (new) | Extract the `search TextInput + FilterChip row + FlatList + BulkActionBar` shape shared by `(inventory)/index.tsx`, `(jobs)/index.tsx`, `(teams)/index.tsx`, `(repairs)/index.tsx`. **Do not convert the screens yet** — land the component + a story/example, then convert in a follow-up wave. |
| W2-sheet | `src/components/ui/EntityEditSheet.tsx` (new) | Extract the `ModalSheet` + fields + `updateXFields()` → `appendOutbox` shape used by the entity edit modals. Same rule: land the component, convert later. |

Splitting "create the component" from "convert the screens" is deliberate. Wave 1 proved the pattern on
the low-risk pickers; the list/sheet shells carry state and side effects, and a bad extraction there
breaks four screens at once.

---

## Regression risks (call out in every agent's report)

- **`SearchablePicker` is inside a `ScrollView` on several screens.** Wrapping it must not change gesture
  handling. If the scroll audit lands a `scrollEnabled` / `keyboardShouldPersistTaps` fix in the
  primitive, `TaxonomyPicker` inherits it — do not re-implement it in the wrapper.
- **`(inventory)/index.tsx` filter chips carry `t.id`, not `t.label`** (post-#74). Preserve that.
- **`manage-types.tsx`** guards four protected location labels (`Shelf`/`Vehicle`/`Shop`/`Office`) and
  must **not** be converted — it edits the taxonomy rather than consuming it. Excluded from every wave.
- **`quickadd/*`** sheets are consumed by the hub flows; their defaults are load-bearing for the
  scan-to-add path. Verify a full scan → quick-add → save round-trip.

## Definition of done

`npx tsc --noEmit` = 0, `npm test` green, dev-client hotloads with no red box, and a manual pass of one
screen per route group confirming the dropdown behaves identically to `main`. Net line count should
*drop*; if a wave adds lines, the abstraction is wrong.
