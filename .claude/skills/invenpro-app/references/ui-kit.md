# UI inventory & house conventions (beyond the kit README)

`src/components/ui/README.md` is the kit contract — read it first. This file
covers what lives OUTSIDE the kit and the idioms call sites are expected to
follow.

## Pickers & inputs (one level up, `src/components/`)

- **SearchablePicker** — ranked entity type-ahead + optional `onCreate` row.
  House conventions:
  - Toggle-select idiom so tapping the selected row ("Change") clears it:
    `onSelect={opt => setX(prev => (prev?.id === opt.id ? null : opt))}`
  - Large catalogs pass `searchFn` (DB-backed per keystroke), small sets pass
    `options`.
  - Mixed-kind option lists distinguish kinds via `sublabel` ("Payer" /
    "Team" / "Job") and resolve the picked kind at submit time by id-set
    membership, not by parsing the sublabel.
- **SuggestInput** — free text + suggestion dropdown (not entity-bound).
- **RecordAutofillInput / AutofillTextField** — record-history autofill with
  the exclusion list (see #121 work); prefer these over raw AppInput for
  fields users retype often.
- **BarcodeInput / BarcodeScanner(+.web)** — scanning; never reimplement.
- **GpsAnchorField / MapPickerModal / LocationSuggestionBanner** — location
  capture & proximity suggestions (`sortByProximity` lives with them).

## Feature building blocks worth knowing before building "new"

- **QuickAdd family** (`quickadd/`): `QuickAddScreenShell` (host screen with
  toast/counter), `QuickAddFooter` (save-and-add-another footer),
  `QuickCreateSheet`, per-entity `*QuickAdd.tsx`. A new "quickly add an X"
  flow is a new `*QuickAdd.tsx` inside this shell — not a new screen.
- **MediaGallery / MediaThumbnail / MediaDetailSheet** — all media display;
  the dashed "＋ Photo" thumb box and the photo-source bottom sheet are
  MediaGallery patterns — copy those, don't invent new affordances.
- **BulkActionBar + useMultiSelect** — list multi-select actions.
- **PermissionGate** — declarative render gate when a whole subtree is
  permission-bound (vs `usePermission` for logic).
- **Fab** — bottom-right floating action button for list screens (gate with
  `usePermission` + `useMaintenanceMode().locked`).
- **ConfirmSheet / confirmSheet() / confirmQueue** + **lib/confirm.ts**
  (`confirmDestructive`) + **lib/themedAlert** (`Alert`) — ALL confirmation
  and alert UX. Never use RN's `Alert` directly; import from
  `lib/themedAlert`.
- **StatusBadge / StatusPill / FilterChip / KeyValueRow / EmptyState** — the
  small display vocabulary; check these before styling a new label/pill.

## Hooks (`src/hooks/`)

- `useDbQuery(fn, deps, tables)` — THE reactive read (see data-patterns.md).
- `useTableVersion([...tables])` / `useDataVersion()` — version counters when
  you need the trigger value itself (e.g. as a `useMemo` dep).
- `usePermission(perm)`, `useSession()`, `useMaintenanceMode()`.
- `useThemedStyles(makeStyles)` + `useTheme()` — every component's styling.
- `useMultiSelect`, `useSuggestions`, `useFormMode` (Simple/Detailed forms),
  `useHiddenFields` (admin-hidden fields → pair with `HidableField`).
- `useFocusOrDataRefresh` / `useReactiveRows` — older reactive idioms; fine
  where they exist, use `useDbQuery` for new code.

## Sheet/keyboard gotchas (hard-won)

- `ModalSheet` uses `react-native-keyboard-controller`'s KAV — RN's own KAV
  does NOT work inside Modals here (#118). `ModalSheet.web.tsx` is the web
  twin; keep render trees in sync.
- Every ScrollView that contains tappable rows above a focused input needs
  `keyboardShouldPersistTaps="handled"` (FormSheet's and SearchablePicker's
  already have it).
- Sheets keep state on close by design (`onClose` only hides); forms that
  must reset per open do it in a `visible`-effect (see AddServiceRecordSheet).
- Theme presentation (`slide-fast` / `spring-bottom` / `center-dialog`) is a
  theme concern — never hardcode animation per sheet.

## Modularity check before you ship

When a new surface duplicates >~30% of an existing one, stop: either extract
the shared part into `ui/` (if ≥2 real consumers) or grow the existing
component with a prop/variant. One-consumer abstractions and copy-paste forks
are both wrong; the kit grows only through proven duplication.
