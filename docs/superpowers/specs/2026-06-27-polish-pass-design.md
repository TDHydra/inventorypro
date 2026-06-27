# Polish Pass — Design Spec

*Date: 2026-06-27 · Branch: `feat/polish-pass` · Post-Phase-3b polish*

## Context

InventoryPro is feature-complete across inventory/users/jobs/equipment/maintenance. This pass
refines what exists along three dimensions the user chose — **visual consistency**, **UX-completeness
states**, and **onboarding & guidance** — grounded in three codebase audits (UX, visual, onboarding).

The audits' key finding: the brand is already coherent (navy `#1E3A5F` header, blue `#2563EB`
primary, `#F8FAFF` backgrounds, slate text). The problems are **duplication** (the same styles
copied across 42 `StyleSheet.create` files, the maintenance-warning string duplicated 10×) and
**missing affordances** (no pull-to-refresh anywhere, a destructive Move-Stock with no confirm,
hints wired on only 1 of 7 screens). So this is a **consistency + completeness** pass, **not a
redesign** — same colors, same layouts, unified into a shared layer.

### Decisions locked with the user
- **Visual depth:** full adoption — every screen migrates to `theme.ts` + shared primitives.
- **Pull-to-refresh:** pull triggers `syncNow()` (push+pull) then re-queries local data.
- The three dimensions are applied **per screen group** (vertical slices), so each agent owns a set
  of screens and does all three at once — no cross-agent file collisions.

## Global Constraints

- Expo SDK 56 — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- op-sqlite bind params: only `string | number | null | ArrayBuffer`.
- **No redesign, no behavior changes** beyond the explicitly listed UX fixes. Visual migration must
  be pixel-equivalent except where a divergence is being *corrected* to the canonical value.
- **Modal dismissal rule (app-wide):** every modal/bottom-sheet closes when the user taps outside it
  (on the backdrop) or presses Android back. Outside-tap dismiss **preserves the modal's input state** —
  reopening shows what was entered. Inputs are cleared ONLY by an explicit Clear button or after a
  successful submit/confirm. A modal that intentionally discards on close must say so explicitly in its
  slice's task. This is enforced structurally by the `ModalSheet` primitive (its `onClose` only toggles
  visibility); migrating a modal means moving any state-reset OUT of the close path.
- **No new permissions, no DB migration, no native module.** All work is JS/TS over Metro.
- `syncNow()` is already exported from `src/sync/engine.ts` (Phase 3a). Pull-to-refresh consumes it.
- Maintenance lockout already gates writes (Phase 3b); the new `MaintenanceBanner` primitive only
  replaces the duplicated inline read-only string — it must render identically (`#B45309`, same copy).
- TypeScript gate only (no unit-test runner): `npx tsc --noEmit` clean (mobile) per task + manual check.

## Shared Context Pack (from the audits)

- **No theme file exists.** `src/constants/` has only hints/locationStyles/roles/teams/units. 60 distinct
  hex values across 46 files; 12 carry ~90% of surface. Divergences to consolidate: primary blue
  `#2563EB`(82×)/`#1D4ED8`(30×); danger `#EF4444`/`#DC2626`/`#B91C1C`; success `#16A34A`/`#15803D`/`#22C55E`.
- **Verbatim-duplicated styles** ready to extract: input formula (12 files, identical), field-label
  formula (11 files), `btnText` (14 files, identical), detail-card (4 files identical), list-card
  (3 files), chip (6 files), modal sheet (7 files), and the maintenance-warning `<Text>` (10 files).
- **Button padding drift:** `paddingVertical: 13` everywhere except `14` in checkin/checkout.
- **UX gaps:** `RefreshControl` used nowhere; `MoveStockModal.handleConfirm` (`src/components/MoveStockModal.tsx:77`)
  depletes stock with no confirm; `(admin)/users.tsx doCreate` (`:282`) async with no spinner/disabled;
  `(admin)/settings.tsx` Sync-now `catch` only `__DEV__`-warns (silent in prod, `:74`); `(logs)/index.tsx`
  All-Activity has error text but no retry (`:233`).
- **Empty states are all covered** — do NOT add more; reuse the new `EmptyState` only where migrating.
- **Onboarding:** `TooltipHint` (`src/components/TooltipHint.tsx`) + `hints.ts` exist; `<TooltipHint>`
  rendered ONLY on dashboard. 6 keys have copy but no component (`checkout/checkin/inventory/scan/users/jobs`);
  no copy for `locations/teams/logs`. `reshowHint` exists inside TooltipHint but isn't exposed — no `'?'`
  button. Low-stock widget on dashboard (`getLowStockItems()`, items.ts:204) renders ≤3 rows, **not tappable**.
- **app_settings** local key/value; `appSettings.ts` only has idle helpers (no generic get/set). Keys in
  use: `schema_version`, `idle_timeout_minutes`, `last_pulled_at`, `hint_seen_*`.
- **Permission gating** of checkout/checkin tiles for office-managers (a silent-fail the audit found) is
  **OUT of scope** (behavior change) — logged as follow-up.

---

## Architecture

### Unit 0 — Foundation (lands FIRST; every slice depends on it)

**`src/theme.ts`** — exported token objects (values straight from the audit):
```ts
export const colors = {
  background: '#F8FAFF', surface: '#fff',
  border: '#E2E8F0', borderDetail: '#EEF2F7',
  textPrimary: '#1E293B', textSecondary: '#64748B', textMuted: '#94A3B8', textDisabled: '#CBD5E1',
  brand: '#1E3A5F', primary: '#2563EB', primaryText: '#1D4ED8',
  primaryBg: '#EFF6FF', primaryBgStrong: '#DBEAFE',
  warning: '#B45309', danger: '#DC2626', dangerBg: '#FEE2E2', success: '#16A34A',
} as const;
export const spacing = { xs: 4, sm: 8, md: 12, base: 14, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;
export const radii = { sm: 8, md: 10, lg: 12, xl: 20 } as const;
export const fontSizes = { xs: 10, sm: 11, caption: 12, body2: 13, body: 14, md: 15, base: 16, lg: 18, xl: 22 } as const;
```
(`primary` consolidates `#2563EB`+most `#1D4ED8`; keep `primaryText` `#1D4ED8` for active-chip text where
the slightly darker tone reads better. `danger`→`#DC2626`, `success`→`#16A34A` are the single canonical picks.)

**Styled primitives** (`src/components/ui/`), each replacing a verbatim-duplicated style. Stable APIs the
slices consume:
- `MaintenanceBanner` — `() => JSX`; renders the `#B45309` "Read-only during maintenance" text. No props.
- `PrimaryButton` — `{ label: string; onPress; disabled?; loading?; tone?: 'primary'|'danger' }`. Fixes
  the 13/14 drift (canonical `paddingVertical: spacing.base-1 → 13`, `radii.lg`); `loading` shows an inline
  `ActivityIndicator` instead of the label.
- `AppInput` — wraps `TextInput` with the canonical input style; passes through standard TextInput props
  (`value/onChangeText/placeholder/keyboardType/autoFocus/...`). `height: 44`.
- `FieldLabel` — `{ children: string }`; the uppercase 12/700/`#64748B` label.
- `FilterChip` — `{ label; active; onPress }`; canonical chip (`F1F5F9`/`DBEAFE`/`primaryText`).
- `Card` — `{ variant?: 'list'|'detail'; style?; children }`; list=`radii.md`+`border`, detail=`radii.lg`+`borderDetail`.
- `ModalSheet` — `{ visible; onClose; children }`; bottom-sheet wrapper (`radii.xl` top corners,
  `padding: spacing.xl`, `maxHeight: '88%'`, `surface` bg). Replaces 7 hand-rolled `<Modal>` shells.
  **Backdrop/outside-tap dismissal:** the dimmed scrim is a `Pressable` whose `onPress` calls `onClose`;
  the sheet content is wrapped so taps on it do NOT bubble to the scrim (`onStartShouldSetResponder={() => true}`
  or a `Pressable` that swallows the press). Android hardware back (`Modal onRequestClose`) also calls `onClose`.
  **`onClose` only HIDES the sheet — it must never clear the caller's input state.** Form/field state lives
  in the parent and persists across an outside-tap dismiss + reopen; it is reset ONLY by an explicit Clear
  control or after a successful submit (see the global modal-behavior rule).

**Shared UX components** (`src/components/ui/`):
- `EmptyState` — `{ title: string; subtitle?: string; cta?: { label; onPress } }`. (Used only where slices
  migrate an existing inline empty state — NOT to add new ones.)
- `LoadingView` — `{ label?: string }`; centered `ActivityIndicator` + optional label.
- `ErrorView` — `{ message: string; onRetry?: () => void }`; inline error text + a Retry button when `onRetry` given.
- `confirmDestructive(opts: { title: string; message?: string; confirmLabel: string; onConfirm: () => void })`
  — helper (`src/lib/confirm.ts`) wrapping the existing `Alert.alert` two-button destructive pattern.

**`src/db/appSettings.ts`** — add generic `getAppSetting(key: string): string | null` and
`setAppSetting(key: string, value: string): void` (mirroring the idle helpers). TooltipHint and the new
onboarding flags use these instead of inline SQL.

**`TooltipHint` enhancement** — expose `reshowHint` so a header `'?'` can re-trigger it. Add an optional
`onReady?: (reshow: () => void) => void` prop called once with the reshow fn; the dashboard/slices pass a
handler that registers it for the header button. (Internal storage switches to `getAppSetting/setAppSetting`.)

### Unit 1..8 — Per-screen-group slices (parallel after Unit 0)

Each slice: (a) replace local btn/input/label/card/chip/modal/maintenance styles with the Unit-0
primitives and swap hardcoded hex/spacing/font literals for `theme.ts` tokens; (b) apply that group's
UX-completeness fix; (c) wire that group's onboarding. Pixel-equivalent except corrected divergences.

**Modals:** any slice that owns a modal/bottom-sheet (S3 add/edit-location, S4 add/edit-team, S5
checkout & checkin confirm sheets, S6 users create/PIN, S8 Move-Stock) migrates it to `ModalSheet` and
thereby gets outside-tap + back-button dismissal **with input state preserved** (per the global modal
rule). The slice must verify its modal's existing close handlers don't reset form state, moving any
reset to the explicit Clear/submit paths.

| Slice | Files | UX fix | Onboarding |
|---|---|---|---|
| **S1 Inventory** | `(inventory)/{index,[id],add,scan}.tsx` | pull-to-refresh on `index` list | `<TooltipHint screenKey="inventory">`, `"scan"` |
| **S2 Jobs** | `(jobs)/{index,[id],create}.tsx` | pull-to-refresh on both `index` tabs | `<TooltipHint screenKey="jobs">` |
| **S3 Locations** | `(locations)/{index,[id]}.tsx` | pull-to-refresh on `index` | render `<TooltipHint screenKey="locations">` (copy added by Unit 0) |
| **S4 Teams** | `(teams)/{index,[id]}.tsx` | pull-to-refresh on `index` | render `<TooltipHint screenKey="teams">` (copy added by Unit 0) |
| **S5 Checkout/Checkin** | `(checkout)/index.tsx`, `(checkin)/index.tsx` | fix btn padding (via PrimaryButton) | `checkout`, `checkin` hints |
| **S6 Admin** | `(admin)/{users,roles,settings}.tsx` | **users create**: `loading` on submit (disable+spinner); **settings Sync-now**: surface failure (inline `ErrorView`/Alert, not silent) | `users` hint |
| **S7 Dashboard/Logs** | `(dashboard)/index.tsx`, `(logs)/index.tsx` | logs All-Activity: pull-to-refresh + `ErrorView` retry; **low-stock widget tappable** (row → item detail) + show total count when >3 | header `'?'` re-show button (consumes `onReady`); render `<TooltipHint screenKey="logs">` (copy added by Unit 0) |
| **S8 MoveStockModal** | `src/components/MoveStockModal.tsx` | **add `confirmDestructive` before the move** | primitives only |

**Pull-to-refresh contract (S1–S4, S7):** wrap the list in `RefreshControl`; `onRefresh` =
`setRefreshing(true)` → `await syncNow()` → re-run the screen's existing local-data loader (e.g.
`setTree(getLocationTree())`) → `setRefreshing(false)`. Guard against overlap with a `refreshing` flag.

### Dependency / collision map
- Unit 0 is the barrier — all slices import from it; it must merge first.
- Slices S1–S8 are **file-disjoint** (each owns its screen group; MoveStockModal is its own file) → fully parallel after Unit 0.
- `_layout.tsx` is touched ONLY by S7 (the `'?'` header button) — no other slice touches it.
- `hints.ts` is appended by S3/S4/S7 (new keys `locations`/`teams`/`logs`) — these are additive, distinct
  keys; to avoid a 3-way edit race, **S0/foundation adds the three empty-keyed entries' copy** and slices
  only render. (Decision: put ALL new hint copy in Unit 0's hints.ts edit; slices just add `<TooltipHint>`.)

---

## File map

| Unit | Files |
|---|---|
| 0 | `src/theme.ts` (new); `src/components/ui/{MaintenanceBanner,PrimaryButton,AppInput,FieldLabel,FilterChip,Card,ModalSheet,EmptyState,LoadingView,ErrorView}.tsx` (new); `src/lib/confirm.ts` (new); `src/db/appSettings.ts` (+generic get/set); `src/components/TooltipHint.tsx` (+`onReady`/`reshow`, use generic settings); `src/constants/hints.ts` (+`locations`/`teams`/`logs` copy) |
| S1 | `app/(app)/(inventory)/{index,[id],add,scan}.tsx` |
| S2 | `app/(app)/(jobs)/{index,[id],create}.tsx` |
| S3 | `app/(app)/(locations)/{index,[id]}.tsx` |
| S4 | `app/(app)/(teams)/{index,[id]}.tsx` |
| S5 | `app/(app)/(checkout)/index.tsx`, `app/(app)/(checkin)/index.tsx` |
| S6 | `app/(app)/(admin)/{users,roles,settings}.tsx` |
| S7 | `app/(app)/(dashboard)/index.tsx`, `app/(app)/(logs)/index.tsx`, `app/(app)/_layout.tsx` |
| S8 | `src/components/MoveStockModal.tsx` |

## Verification
- `npx tsc --noEmit` clean (mobile) per slice + at the end.
- Visual: each migrated screen renders pixel-equivalent (spot-check on device via Metro) except corrected
  divergences (button heights uniform; chips uniform; one red/green/blue per role; maintenance banner identical).
- UX: pull-to-refresh spins + syncs + reloads on each list; Move-Stock shows a confirm before depleting;
  users-create disables+spins during the request and surfaces errors; settings Sync-now shows failures;
  logs All-Activity shows a Retry on error.
- Onboarding: each of the 7 screens shows its first-visit hint once (then suppressed); the header `'?'`
  re-shows it; low-stock rows navigate to item detail and show the total count.
- Maintenance lockout still works (banner via the new primitive; write-CTA disabling unchanged).
- **Modals:** every migrated modal closes on outside-tap and Android back; reopening after an outside-tap
  dismiss preserves the entered inputs; Clear/submit still reset as before. Tapping inside the sheet does
  not dismiss it.

## Out of scope (logged follow-ups)
- Permission-gating checkout/checkin tiles for office-managers (tier-3 `checkout_inventory:false`) — a real
  silent-fail, but a **behavior** change, not polish.
- Auth/PINPad bespoke sizing (intentional, untouched).
- Reactive post-sync auto-refresh of already-open lists without a pull gesture (pull-to-refresh covers the manual case).
- New empty states (all already covered).
