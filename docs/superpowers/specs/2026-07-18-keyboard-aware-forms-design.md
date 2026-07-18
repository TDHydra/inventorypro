# App-wide keyboard-aware forms (#118)

**Date:** 2026-07-18
**Issue:** #118 — App-wide keyboard-aware forms: scroll the selected input into view when the keyboard opens (build into the theme engine / shared shell)
**Branch:** `feat/keyboard-aware-forms-118`

## Problem

Every screen must be *fluid* when the on-screen keyboard slides up: the form should
move up so the input the user selected stays visible above the keyboard — you should
always be able to see what you are typing or the field you are selecting. This must
apply to **every** form screen.

Today keyboard handling is hand-rolled per screen (`KeyboardAvoidingView` + `ScrollView`
+ `keyboardShouldPersistTaps`) and **none of it scrolls the _focused_ field into view** —
long forms leave the selected input hidden behind the keyboard. The chat thread (#89) added
a bespoke composer-pinned layout by hand; most form screens have nothing reliable.

## Constraints / environment (verified)

- Expo SDK **56** (`~56.0.12`), React Native **0.85.3**, **new architecture ON**
  (`android/gradle.properties: newArchEnabled=true`).
- Already installed (hoisted to monorepo root `node_modules`): `react-native-reanimated@4.5.0`,
  `react-native-gesture-handler@3.0.2`, `react-native-safe-area-context@5.8.0`,
  `react-native-screens@4.25.2`.
- **Missing:** `react-native-keyboard-controller` — the only new native module to add.
- **No app-level `SafeAreaProvider`** yet. `useSafeAreaInsets()` (used by chat) currently
  returns fallback `0` values. Adding a provider is part of this work.
- The app ships a **web build** (Expo Web + sql.js). `react-native-keyboard-controller` is
  native-only, so the shell must degrade to a plain `ScrollView` on web.
- Read `apps/mobile/AGENTS.md`: consult the versioned Expo v56 docs before writing code.

## Decisions

1. **Engine:** adopt `react-native-keyboard-controller` (`KeyboardAwareScrollView`).
   Native-synced, buttery scroll of the *focused* field (and pickers) into view — the
   "fluid" behavior the issue describes. Marginal cost is low because reanimated +
   gesture-handler are already present. Requires a **dev-client rebuild** for Phase 0.
2. **Theme tie-in:** one shared shell in the ui/theme layer that every form screen uses,
   **plus** a small `keyboard` block on the theme contract so themes can tune the feel.

## Architecture

### 1. Provider / native layer
- Add `react-native-keyboard-controller` (pin a version supporting RN 0.85 / new arch /
  reanimated 4 — v1.18+; verify at install against current docs).
- `app/_layout.tsx`: wrap the tree, outermost → inner:
  `<SafeAreaProvider>` → `<KeyboardProvider>` → existing `<Stack key={theme.id}>`.
  Providers sit **above** the theme-keyed Stack remount, so a theme switch never tears
  them down.
- **Watch-out:** once `SafeAreaProvider` is live, `useSafeAreaInsets()` returns *real*
  bottom insets. Chat's `composerInsets` math already folds the inset back out; re-verify
  chat does not suddenly double-pad.

### 2. Theme lever (`themes/types.ts` + every theme file + `createTheme`)
Add to the `Theme` contract:
```ts
export interface ThemeKeyboard {
  /** Breathing room kept between the focused field's bottom and the keyboard top.
   *  Maps to KeyboardAwareScrollView `bottomOffset`. */
  focusExtraOffset: number;
}
// Theme gains: keyboard: ThemeKeyboard;
```
- `createTheme` provides a sensible base default (≈ `spacing.base`). Each theme file
  (`original`, `modern`, `classic`, `fluid`, `futuristic`, `debug`) may override — Fluid
  roomier, Classic tighter.
- The scroll **animation is native + keyboard-synced** (that is what makes it fluid), so the
  theme lever is the *offset*, not a duration. This is intentional and documented; we do not
  pretend the theme controls timing.

### 3. Shared shell — `src/components/ui/FormScreen.tsx`
Single component every form screen uses instead of hand-rolling `KeyboardAvoidingView` +
`ScrollView`.
- Native: renders `KeyboardAwareScrollView` with
  `bottomOffset={theme.keyboard.focusExtraOffset}`, `keyboardShouldPersistTaps="handled"`.
- Themed background + content padding; adds `useSafeAreaInsets().bottom` to the content's
  bottom padding via the `formScreenInsets` helper.
- Optional `footer` prop (sticky action/save bar) → wrapped in `KeyboardStickyView` so a
  bottom "Save" button floats above the keyboard. **Off unless a screen opts in** — forces
  nothing on existing screens.
- **Web fallback:** on `Platform.OS === 'web'`, render a plain `ScrollView` (keyboard-controller
  is native-only) so the web build does not break.
- Props (superset): `children`, `contentContainerStyle?`, `footer?`, `scrollRef?`,
  `keyboardShouldPersistTaps?` (default `'handled'`), `testID?`, plus passthrough for
  `bottomOffset` override.
- Pure helper `src/formScreenInsets.ts` (bottom padding = base + safe inset, guarding NaN/neg)
  lives under `src/` (NOT `app/` — Expo Router globs `app/**` into the route bundle and a
  co-located `*.test.ts` breaks Metro). Unit-tested under `node --test`, mirroring the
  existing `src/chat/composerInsets.ts` pattern.

### 4. Adoption
- **`QuickAddScreenShell`** refactored to use `FormScreen` internally → all ~11 quick-add
  screens inherit the behavior for free.
- Migrate high-traffic standalone forms (replace bespoke `KeyboardAvoidingView` + `ScrollView`):
  `(inventory)/add`, `(inventory)/[id]`, `(equipment)/add`, `(equipment)/[id]`,
  `(jobs)/create`, `(jobs)/[id]`, `(repairs)/new`, `(checkout)/index`, `(checkin)/index`,
  `(admin)/roles`, `(admin)/settings`, `(auth)/login`, `(auth)/unlock`. A discovery grep for
  `TextInput`/`AppInput`/`SuggestInput` enumerates any others so none are missed.
- **Chat `(chat)/[id].tsx` stays on its own bespoke composer layout** (inverted message list
  + pinned composer from #89 — a different pattern from a scrolling form). Out of scope to
  avoid regressing working behavior; its composer can move to `KeyboardStickyView` later.
- `ModalSheet.tsx` keeps its own keyboard handling for now unless a form inside a sheet is
  demonstrably broken; evaluated during migration.

## Phasing (build dev APK + hotload after each — per CLAUDE.md)

- **Phase 0** — add dep + providers → **rebuild dev client** + hotload, confirm the app boots
  with the new native module. (Rebuild required: the phone's existing dev client has no
  keyboard-controller native code, so JS importing it would crash without a fresh build.)
- **Phase 1** — theme lever + `FormScreen` + `formScreenInsets` (+ test) + refactor
  `QuickAddScreenShell` (11 screens) + migrate 2 exemplars (`inventory/add`, `checkout`) →
  hotload (JS-only), device-verify.
- **Phase 2** — migrate remaining standalone/edit/admin/auth forms following the recipe →
  hotload, verify.
- **Phase 3** — remove dead `KeyboardAvoidingView` imports, Classic-theme check, docs, final
  Android S24 sweep across representative screens.

## Error handling / edge cases

- `keyboardShouldPersistTaps="handled"` so tapping a picker/dropdown option while the keyboard
  is open does not dismiss it first.
- Guard the `SafeAreaProvider` rollout against double-padding on screens that assumed `0`.
- Confirm `react-native-keyboard-controller` version compatibility with reanimated 4 / RN 0.85
  at install time.
- Web path renders plain `ScrollView`; no keyboard-controller import is evaluated on web.

## Testing / acceptance

- Native behavior → **device verification is the real gate**: on every migrated form,
  focusing any field scrolls it fully into view above the keyboard; the selected input/picker
  is never hidden. Verified on Android S24 across representative screens (issue requirement).
- `formScreenInsets` unit-tested under `node --test`.
- Web build smoke-checked via the fallback path.
- `tsc` clean across the mobile app.

## Out of scope

- Chat composer migration (works today via #89).
- Any unrelated refactor of the touched screens beyond swapping in `FormScreen`.
