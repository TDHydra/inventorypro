# `src/components/ui/` — component kit contract

Shared building blocks for screens and feature components. Grab one of these
before hand-rolling a card/button/field/sheet again.

## Components

- **AppInput** — canonical themed `TextInput`; carries the app's input style
  (height 44, `radii.md`, `colors.border`, `fontSizes.body`) and spreads all
  `TextInputProps`. Optional `right?: ReactNode` overlays a trailing adornment
  (clear button, chevron, …) without changing existing call sites.
- **TextField** — `Field` + `AppInput` in one line; label/required/hint/error
  plus a `multiline` variant.
- **Field** — label + hint/error wrapper for a single form field (no input
  opinion; wrap any control).
- **FieldLabel** — the small caps section-label text used above fields/rows.
- **PrimaryButton** — the app's filled action button (`primary`/`danger` tone,
  `loading`/`disabled` states).
- **FormActions** — the Cancel + Save button row every edit form uses.
- **Card** — bordered surface container (`list` | `detail` variant).
- **ModalSheet** — bottom sheet modal (backdrop + keyboard-avoiding scroll),
  with the Android nav-bar inset baked in.
- **EntityEditSheet** — `ModalSheet` + `FormActions` wired together for a
  single-entity edit form; the caller owns persistence.
- **ListScreenShell** — list screen scaffold: `FlatList` + pull-to-refresh +
  filter chips + bulk-select action bar.
- **FilterChip** — single filter pill (active/inactive) used by
  `ListScreenShell` and standalone filter rows.
- **DragList** — generic drag-to-reorder list (absolutely positioned rows,
  `PanResponder` + `Animated`).
- **EmptyState** — icon/title/subtitle/CTA placeholder for empty lists.
- **ErrorView** — message + optional Retry button.
- **LoadingView** — centered spinner + optional label.
- **MaintenanceBanner** — the fixed "Read-only during maintenance" banner text.
- **AdvancedFields** — collapses optional fields behind a "Show advanced
  fields" toggle in Simple form mode; renders inline (no toggle) in Detailed
  mode.
- **HidableField** — renders children only when the field is not hidden by
  admin config (fully absent, not just collapsed).

`SuggestInput` (free-text + suggestion dropdown) and `SearchablePicker`
(ranked entity search + create) live one level up in `src/components/` — they
compose `AppInput` but aren't part of this kit's exports.

## Hard constraints

- **JS-only** — no new native modules. `reanimated`, `gesture-handler`,
  `@gorhom/bottom-sheet`, `safe-area-context`, `vector-icons`,
  `datetimepicker` are all absent from this app, and adding one forces a
  dev-client rebuild, which breaks hotload.
- **Web-safe** — RN core primitives only (`react-native-web` 0.21). DB access,
  if ever needed, only via `getDb()` from `src/db/schema`.
- **Style via tokens** — `StyleSheet.create` + `src/theme.ts` tokens
  (`colors`, `spacing`, `radii`, `fontSizes`). No hardcoded hex.
- **Icons are text/emoji** — no icon library.
- **Shape** — named function components, inline `interface Props`, relative
  imports.
- **Accessibility (#219)** — every interactive primitive carries
  `accessibilityRole` (+ `accessibilityLabel` when the visible text isn't the
  whole story, e.g. icon/emoji-only or loading states) and
  `accessibilityState` for `disabled`/`selected`. Small targets take
  `KIT_HIT_SLOP` from `./hitSlop`. ToastHost's action button is the reference
  pattern.

Wave B items add their own usage notes as doc-comments in their own files,
not here — keeps this file conflict-free under parallel edits.
