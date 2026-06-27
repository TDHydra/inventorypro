# Polish Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`. **Verification gate:** no unit-test runner — the gate per task is `npx tsc --noEmit` clean (controller, mobile) + the task's manual check. Implementer agents do **NO git and NO tsc**; the controller runs tsc, commits explicit file paths per task, reviews.

**Goal:** Rebrand to the SERVPRO palette and unify the app onto a shared theme + primitives, while filling UX-completeness gaps (pull-to-refresh, confirms, loading/error states), wiring onboarding hints, and making all modals dismiss-on-outside-tap while preserving inputs.

**Architecture:** A foundation layer (`theme.ts` tokens + `src/components/ui/*` primitives + helpers) lands first; then 8 file-disjoint screen-group "slices" each adopt the primitives/tokens and apply their own UX fix + onboarding + modal migration. JS/TS only — no migration, no native, no new permission.

**Tech Stack:** Expo SDK 56, React Native, expo-router, `@op-engineering/op-sqlite`.

## Global Constraints

- Expo SDK 56 — consult `https://docs.expo.dev/versions/v56.0.0/` before native/API code.
- op-sqlite bind params: only `string | number | null | ArrayBuffer`.
- **SERVPRO palette** (exact values, verbatim): brand green `#183028`, primary green `#1E7E4E`, primaryText `#176B43`, primaryBg `#E8F1ED`, primaryBgStrong `#D3E6DC`, accent orange `#F28000`, accentBg `#FFF1E6`, warning `#F28000`, danger `#DC2626`, dangerBg `#FEE2E2`, success `#16A34A`, background `#F6F8F7`, surface `#fff`, border `#E2E8F0`, borderDetail `#EEF2F7`, textPrimary `#1E293B`, textSecondary `#64748B`, textMuted `#94A3B8`, textDisabled `#CBD5E1`. **No blue/navy may remain** (`#2563EB`/`#1D4ED8`/`#1E3A5F` → zero hits post-migration).
- **No layout redesign, no behavior changes** beyond the listed UX fixes. Layout/spacing stays equivalent; only colors rebrand + specific divergences (button heights, chip shapes, modal bg/title) correct to canonical.
- **Modal rule (app-wide):** every modal/bottom-sheet closes on backdrop tap + Android back; dismiss **preserves input state** (reset only on explicit Clear or successful submit). Enforced by `ModalSheet` (its `onClose` only toggles visibility).
- No DB migration, no native module, no new permission. `syncNow()` already exported from `src/sync/engine.ts`.
- Full Shared Context Pack in the spec: `docs/superpowers/specs/2026-06-27-polish-pass-design.md` — every brief ships with it.

---

# WAVE 0 — Foundation (T1, T2 disjoint, parallel). Slices depend on BOTH.

### Task 1: Theme tokens + styled UI primitives

**Files:** Create `apps/mobile/src/theme.ts`; create `apps/mobile/src/components/ui/{MaintenanceBanner,PrimaryButton,AppInput,FieldLabel,FilterChip,Card,ModalSheet,EmptyState,LoadingView,ErrorView}.tsx`

**Interfaces — Produces (slices consume these exact signatures):**
- `theme.ts`: `colors`, `spacing`, `radii`, `fontSizes` (objects below).
- `MaintenanceBanner: () => JSX` (no props)
- `PrimaryButton: (props: { label: string; onPress: () => void; disabled?: boolean; loading?: boolean; tone?: 'primary' | 'danger'; style?: object }) => JSX`
- `AppInput: (props: TextInputProps) => JSX` (forwards all RN `TextInput` props; applies canonical style; caller may pass `style` to extend)
- `FieldLabel: (props: { children: string; style?: object }) => JSX`
- `FilterChip: (props: { label: string; active: boolean; onPress: () => void }) => JSX`
- `Card: (props: { variant?: 'list' | 'detail'; style?: object; children: React.ReactNode }) => JSX`
- `ModalSheet: (props: { visible: boolean; onClose: () => void; children: React.ReactNode }) => JSX`
- `EmptyState: (props: { title: string; subtitle?: string; cta?: { label: string; onPress: () => void } }) => JSX`
- `LoadingView: (props: { label?: string }) => JSX`
- `ErrorView: (props: { message: string; onRetry?: () => void }) => JSX`

- [ ] **Step 1: `src/theme.ts`** — exactly:
```ts
export const colors = {
  background: '#F6F8F7', surface: '#fff',
  border: '#E2E8F0', borderDetail: '#EEF2F7',
  textPrimary: '#1E293B', textSecondary: '#64748B', textMuted: '#94A3B8', textDisabled: '#CBD5E1',
  brand: '#183028', primary: '#1E7E4E', primaryText: '#176B43',
  primaryBg: '#E8F1ED', primaryBgStrong: '#D3E6DC',
  accent: '#F28000', accentBg: '#FFF1E6',
  warning: '#F28000', danger: '#DC2626', dangerBg: '#FEE2E2', success: '#16A34A',
} as const;
export const spacing = { xs: 4, sm: 8, md: 12, base: 14, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;
export const radii = { sm: 8, md: 10, lg: 12, xl: 20 } as const;
export const fontSizes = { xs: 10, sm: 11, caption: 12, body2: 13, body: 14, md: 15, base: 16, lg: 18, xl: 22 } as const;
```

- [ ] **Step 2: `ui/MaintenanceBanner.tsx`**:
```tsx
import { Text, StyleSheet } from 'react-native';
import { colors, spacing, fontSizes } from '../../theme';

export function MaintenanceBanner() {
  return <Text style={s.text}>Read-only during maintenance</Text>;
}
const s = StyleSheet.create({
  text: { color: colors.warning, marginTop: spacing.sm, fontSize: fontSizes.body2, fontWeight: '600' },
});
```

- [ ] **Step 3: `ui/PrimaryButton.tsx`**:
```tsx
import { TouchableOpacity, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { colors, radii, spacing, fontSizes } from '../../theme';

interface Props { label: string; onPress: () => void; disabled?: boolean; loading?: boolean; tone?: 'primary' | 'danger'; style?: object; }
export function PrimaryButton({ label, onPress, disabled, loading, tone = 'primary', style }: Props) {
  const bg = tone === 'danger' ? colors.danger : colors.primary;
  return (
    <TouchableOpacity
      style={[s.btn, { backgroundColor: bg }, (disabled || loading) && s.disabled, style]}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.85}
    >
      {loading ? <ActivityIndicator color="#fff" /> : <Text style={s.text}>{label}</Text>}
    </TouchableOpacity>
  );
}
const s = StyleSheet.create({
  btn: { paddingVertical: 13, borderRadius: radii.lg, alignItems: 'center', justifyContent: 'center', minHeight: 48 },
  disabled: { opacity: 0.5 },
  text: { color: '#fff', fontWeight: '700', fontSize: fontSizes.base },
});
```

- [ ] **Step 4: `ui/AppInput.tsx`**:
```tsx
import { TextInput, TextInputProps, StyleSheet } from 'react-native';
import { colors, radii, spacing, fontSizes } from '../../theme';

export function AppInput({ style, placeholderTextColor, ...rest }: TextInputProps) {
  return <TextInput style={[s.input, style]} placeholderTextColor={placeholderTextColor ?? colors.textMuted} {...rest} />;
}
const s = StyleSheet.create({
  input: {
    backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.base, height: 44, fontSize: fontSizes.body, color: colors.textPrimary,
  },
});
```

- [ ] **Step 5: `ui/FieldLabel.tsx`**:
```tsx
import { Text, StyleSheet } from 'react-native';
import { colors, fontSizes } from '../../theme';

export function FieldLabel({ children, style }: { children: string; style?: object }) {
  return <Text style={[s.label, style]}>{children}</Text>;
}
const s = StyleSheet.create({
  label: { fontSize: fontSizes.caption, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
});
```

- [ ] **Step 6: `ui/FilterChip.tsx`**:
```tsx
import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { colors, radii, spacing, fontSizes } from '../../theme';

export function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[s.chip, active && s.chipActive]} onPress={onPress} activeOpacity={0.8}>
      <Text style={[s.text, active && s.textActive]}>{label}</Text>
    </TouchableOpacity>
  );
}
const s = StyleSheet.create({
  chip: { backgroundColor: '#F1F5F9', borderRadius: radii.xl, paddingHorizontal: spacing.base, paddingVertical: spacing.sm },
  chipActive: { backgroundColor: colors.primaryBgStrong },
  text: { fontSize: fontSizes.body2, color: colors.textSecondary, fontWeight: '600' },
  textActive: { color: colors.primaryText },
});
```

- [ ] **Step 7: `ui/Card.tsx`**:
```tsx
import { View, StyleSheet } from 'react-native';
import { colors, radii, spacing } from '../../theme';

export function Card({ variant = 'list', style, children }: { variant?: 'list' | 'detail'; style?: object; children: React.ReactNode }) {
  return <View style={[variant === 'detail' ? s.detail : s.list, style]}>{children}</View>;
}
const s = StyleSheet.create({
  list: { backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, padding: spacing.base },
  detail: { backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.borderDetail, padding: spacing.lg },
});
```

- [ ] **Step 8: `ui/ModalSheet.tsx`** — backdrop tap + Android back dismiss; inner taps swallowed; `onClose` only hides:
```tsx
import { Modal, View, Pressable, StyleSheet } from 'react-native';
import { colors, radii, spacing } from '../../theme';

export function ModalSheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: React.ReactNode }) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      {/* Backdrop: tapping it closes. Pressing the sheet does not (inner Pressable swallows the press). */}
      <Pressable style={s.overlay} onPress={onClose}>
        <Pressable style={s.sheet} onPress={() => {}}>
          {children}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
const s = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(15,23,42,0.45)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    padding: spacing.xl, maxHeight: '88%',
  },
});
```

- [ ] **Step 9: `ui/EmptyState.tsx`**:
```tsx
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, spacing, fontSizes, radii } from '../../theme';

interface Props { title: string; subtitle?: string; cta?: { label: string; onPress: () => void }; }
export function EmptyState({ title, subtitle, cta }: Props) {
  return (
    <View style={s.wrap}>
      <Text style={s.title}>{title}</Text>
      {subtitle ? <Text style={s.sub}>{subtitle}</Text> : null}
      {cta ? (
        <TouchableOpacity style={s.cta} onPress={cta.onPress} activeOpacity={0.85}>
          <Text style={s.ctaText}>{cta.label}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
const s = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl, gap: spacing.sm },
  title: { fontSize: fontSizes.base, fontWeight: '700', color: colors.textSecondary, textAlign: 'center' },
  sub: { fontSize: fontSizes.body2, color: colors.textMuted, textAlign: 'center' },
  cta: { marginTop: spacing.sm, backgroundColor: colors.primary, borderRadius: radii.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  ctaText: { color: '#fff', fontWeight: '700', fontSize: fontSizes.body },
});
```

- [ ] **Step 10: `ui/LoadingView.tsx`**:
```tsx
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { colors, spacing, fontSizes } from '../../theme';

export function LoadingView({ label }: { label?: string }) {
  return (
    <View style={s.wrap}>
      <ActivityIndicator size="large" color={colors.primary} />
      {label ? <Text style={s.label}>{label}</Text> : null}
    </View>
  );
}
const s = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl, gap: spacing.md },
  label: { fontSize: fontSizes.body2, color: colors.textMuted },
});
```

- [ ] **Step 11: `ui/ErrorView.tsx`**:
```tsx
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, spacing, fontSizes, radii } from '../../theme';

export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={s.wrap}>
      <Text style={s.msg}>{message}</Text>
      {onRetry ? (
        <TouchableOpacity style={s.btn} onPress={onRetry} activeOpacity={0.85}>
          <Text style={s.btnText}>Retry</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
const s = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  msg: { fontSize: fontSizes.body, color: colors.danger, textAlign: 'center' },
  btn: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  btnText: { color: colors.primaryText, fontWeight: '700', fontSize: fontSizes.body },
});
```

- [ ] **Step 12 (controller): verify** `cd apps/mobile && npx tsc --noEmit` clean.
- [ ] **Step 13 (controller): commit** `feat(ui): SERVPRO theme tokens + shared primitives`.

---

### Task 2: Helpers + onboarding foundation

**Files:** Create `apps/mobile/src/lib/confirm.ts`; Modify `apps/mobile/src/db/appSettings.ts`, `apps/mobile/src/components/TooltipHint.tsx`, `apps/mobile/src/constants/hints.ts`

**Interfaces — Produces:**
- `confirmDestructive(opts: { title: string; message?: string; confirmLabel: string; onConfirm: () => void }): void`
- `getAppSetting(key: string): string | null`, `setAppSetting(key: string, value: string): void`
- `TooltipHint` gains optional prop `onReady?: (reshow: () => void) => void` (called once with the reshow fn).
- `hints.ts`: new keys `locations`, `teams`, `logs`.

- [ ] **Step 1: `src/lib/confirm.ts`**:
```ts
import { Alert } from 'react-native';

/** Two-button destructive confirm. The confirm button uses the iOS 'destructive' style. */
export function confirmDestructive(opts: { title: string; message?: string; confirmLabel: string; onConfirm: () => void }): void {
  Alert.alert(opts.title, opts.message, [
    { text: 'Cancel', style: 'cancel' },
    { text: opts.confirmLabel, style: 'destructive', onPress: opts.onConfirm },
  ]);
}
```

- [ ] **Step 2: `src/db/appSettings.ts`** — append generic helpers (keep the existing idle helpers):
```ts
/** Reads any app_settings value, or null if unset. */
export function getAppSetting(key: string): string | null {
  try {
    const rows = getDb().executeSync(`SELECT value FROM app_settings WHERE key = ?`, [key]).rows as { value: string }[];
    return rows.length ? rows[0].value : null;
  } catch {
    return null;
  }
}
/** Writes any app_settings value. */
export function setAppSetting(key: string, value: string): void {
  getDb().executeSync(`INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)`, [key, value]);
}
```

- [ ] **Step 3: `src/components/TooltipHint.tsx`** — (a) replace the inline `hintSeen`/`markHintSeen` SQL with `getAppSetting`/`setAppSetting` (`hint_seen_${screenKey}`); (b) add the `onReady` prop so a parent can grab the existing `reshowHint`. Add to `interface Props`: `onReady?: (reshow: () => void) => void;`. Inside the component, after `reshowHint` is defined, add:
```tsx
  useEffect(() => { onReady?.(reshowHint); }, []);
```
(`reshowHint` is stable enough for this one-shot registration; the empty dep array registers it once on mount. Keep the existing `style` prop and render unchanged.)

- [ ] **Step 4: `src/constants/hints.ts`** — add three keys to the `HINTS` map, matching the existing tier-keyed shape (`{ [tier: number]: string }`). Use this copy:
```ts
  locations: {
    1: 'Browse storage locations here. Tap one to see what stock it holds.',
    2: 'Manage warehouses, shops, and vans. Tap “+ New” to add a location or sub-area.',
  },
  teams: {
    1: 'Your teams appear here. Tap a team to see its roster.',
    3: 'Create teams and assign members. Managers can set per-team permission overrides.',
  },
  logs: {
    1: 'Every action you take is logged here for accountability.',
    3: 'Filter the full activity log by user, action, or date across the whole org.',
  },
```
(The component falls back to tier 1 when a higher tier isn't present, so partial tier coverage is fine.)

- [ ] **Step 5 (controller): verify** `cd apps/mobile && npx tsc --noEmit` clean.
- [ ] **Step 6 (controller): commit** `feat(ui): confirm helper, generic app_settings, TooltipHint reshow, new hint copy`.

---

# WAVE 1 — Screen slices (S1–S8, file-disjoint, parallel after T1+T2)

**Shared transform every slice applies to each of its files:**
1. **Import tokens/primitives** from `../../theme` / `../../components/ui/...` (adjust depth) and **replace hardcoded values**: every blue/navy hex (`#2563EB`/`#1D4ED8`/`#1E3A5F`) → `colors.primary`/`colors.primaryText`/`colors.brand`; the three reds → `colors.danger`; the three greens → `colors.success`; backgrounds `#F8FAFF` → `colors.background`; other recurring hex → the matching token. Leave neutral slate text/border literals only if a token doesn't exist (prefer the token).
2. **Swap duplicated styled blocks for primitives** where they appear: primary buttons → `<PrimaryButton>`; text inputs with the canonical style → `<AppInput>`; uppercase field labels → `<FieldLabel>`; filter chips → `<FilterChip>`; cards → `<Card variant=…>`; the `{locked && <Text…>Read-only during maintenance</Text>}` → `{locked && <MaintenanceBanner />}`; inline empty-state `<View><Text>…</Text></View>` blocks → `<EmptyState>` (same copy; only where one already exists — do NOT add new ones).
3. **Migrate modals to `<ModalSheet visible onClose>`** (replace the hand-rolled `<Modal transparent>` + overlay `<View>`). The `onClose` must ONLY set the visibility state to false — **move any field-reset out of the close path** into the explicit Clear/submit handlers, so an outside-tap dismiss preserves inputs.
4. Keep all logic/behavior identical otherwise. The implementer reads each file first.

**Pull-to-refresh canonical snippet** (for the slices that add it). For a `FlatList`, add a `refreshControl`; for a `ScrollView`, add the `refreshControl` prop:
```tsx
import { RefreshControl } from 'react-native';
import { syncNow } from '../../../src/sync/engine';
import { colors } from '../../../src/theme';
// inside the component:
const [refreshing, setRefreshing] = useState(false);
const onRefresh = useCallback(async () => {
  if (refreshing) return;
  setRefreshing(true);
  try { await syncNow(); } catch { /* offline — local reload still runs */ }
  reloadLocalData();           // re-run THIS screen's existing local loader (e.g. setTree(getLocationTree()))
  setRefreshing(false);
}, [refreshing]);
// on the list:
refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />}
```
Each slice wires `reloadLocalData()` to whatever that screen already uses to read its local data (the implementer identifies it).

---

### Task 3 (S1 — Inventory)
**Files:** Modify `app/(app)/(inventory)/{index,[id],add,scan}.tsx`
- [ ] **Step 1:** Apply the shared transform to all four files (tokens + primitives + any modal migration + MaintenanceBanner in `add.tsx`).
- [ ] **Step 2:** Add pull-to-refresh to the `index.tsx` FlatList (canonical snippet; `reloadLocalData` re-runs its item query).
- [ ] **Step 3:** Render `<TooltipHint screenKey="inventory" />` on `index.tsx` and `<TooltipHint screenKey="scan" />` on `scan.tsx` (import from `../../../src/components/TooltipHint`), placed near the top of the screen content (match the dashboard's placement).
- [ ] **Step 4 (controller): verify** `npx tsc --noEmit` clean. **Step 5 (controller): commit** `feat(polish): inventory slice — theme + PTR + hints`.

### Task 4 (S2 — Jobs)
**Files:** Modify `app/(app)/(jobs)/{index,[id],create}.tsx`
- [ ] **Step 1:** Apply the shared transform (tokens + primitives; `create.tsx` MaintenanceBanner; migrate any modal).
- [ ] **Step 2:** Add pull-to-refresh to BOTH tabs' lists on `index.tsx` (My Checkouts + All Jobs; each re-runs its own `useMemo`-backed loader — convert the needed `useMemo` to state + a reload fn the refresh calls, or re-query directly).
- [ ] **Step 3:** Render `<TooltipHint screenKey="jobs" />` on `index.tsx`.
- [ ] **Step 4 (controller): verify** clean. **Step 5 (controller): commit** `feat(polish): jobs slice — theme + PTR + hints`.

### Task 5 (S3 — Locations)
**Files:** Modify `app/(app)/(locations)/{index,[id]}.tsx`
- [ ] **Step 1:** Apply the shared transform. `index.tsx` has the add-location `<Modal>` and `[id].tsx` the edit/move modals → migrate to `<ModalSheet>`, ensuring close preserves inputs (reset only on Clear/submit).
- [ ] **Step 2:** Add pull-to-refresh to `index.tsx` (it's a `ScrollView` tree; `reloadLocalData` re-runs the location-tree builder).
- [ ] **Step 3:** Render `<TooltipHint screenKey="locations" />` on `index.tsx`.
- [ ] **Step 4 (controller): verify** clean. **Step 5 (controller): commit** `feat(polish): locations slice — theme + modals + PTR + hint`.

### Task 6 (S4 — Teams)
**Files:** Modify `app/(app)/(teams)/{index,[id]}.tsx`
- [ ] **Step 1:** Apply the shared transform; migrate the add-team / member modals to `<ModalSheet>` (close preserves inputs).
- [ ] **Step 2:** Add pull-to-refresh to `index.tsx`.
- [ ] **Step 3:** Render `<TooltipHint screenKey="teams" />` on `index.tsx`.
- [ ] **Step 4 (controller): verify** clean. **Step 5 (controller): commit** `feat(polish): teams slice — theme + modals + PTR + hint`.

### Task 7 (S5 — Checkout/Checkin)
**Files:** Modify `app/(app)/(checkout)/index.tsx`, `app/(app)/(checkin)/index.tsx`
- [ ] **Step 1:** Apply the shared transform. The primary confirm buttons use `paddingVertical: 14` — replacing them with `<PrimaryButton>` corrects them to the canonical 13 automatically. Migrate the checkin return-modals to `<ModalSheet>` (close preserves the selected location/qty inputs). Replace the `MaintenanceBanner` inline strings.
- [ ] **Step 2:** Render `<TooltipHint screenKey="checkout" />` (checkout) and `<TooltipHint screenKey="checkin" />` (checkin).
- [ ] **Step 3 (controller): verify** clean. **Step 4 (controller): commit** `feat(polish): checkout/checkin slice — theme + primitives + modals + hints`.

### Task 8 (S6 — Admin)
**Files:** Modify `app/(app)/(admin)/{users,roles,settings}.tsx`
- [ ] **Step 1:** Apply the shared transform; migrate the users create/PIN modals to `<ModalSheet>` (close preserves inputs). Fix the `modalTitle` `fontSize: 20`→`fontSizes.lg` and search `height: 42` divergences via the primitives/tokens.
- [ ] **Step 2 (UX — users create loading):** in `users.tsx doCreate`, gate the submit with a loading flag: set a `creating` state true before `createUserOnline`, false in `finally`; pass `loading={creating}` to the `<PrimaryButton>` create button (disables + spins). Prevents double-submit + gives feedback.
- [ ] **Step 3 (UX — settings sync error):** in `settings.tsx` the Sync-now handler's `catch` currently only `__DEV__`-warns. Add user-visible failure: set a `syncError` state and render an `<ErrorView message={syncError} />` (or an `Alert.alert('Sync failed', …)`) on catch; clear it on the next attempt/success. Keep the existing "Syncing…" label behavior.
- [ ] **Step 4:** Render `<TooltipHint screenKey="users" />` on `users.tsx`.
- [ ] **Step 5 (controller): verify** clean. **Step 6 (controller): commit** `feat(polish): admin slice — theme + modals + users-loading + sync-error`.

### Task 9 (S7 — Dashboard/Logs + header)
**Files:** Modify `app/(app)/(dashboard)/index.tsx`, `app/(app)/(logs)/index.tsx`, `app/(app)/_layout.tsx`
- [ ] **Step 1:** Apply the shared transform to dashboard + logs. In `_layout.tsx`: change `headerStyle.backgroundColor` `#1E3A5F`→`colors.brand`; recolor the Phase-3b lockout banner styles (`banLocked` bg → `colors.warning`, `banAdmin` bg → `colors.brand`) using tokens. The header's `'?'` button is added in Step 4.
- [ ] **Step 2 (UX — low-stock widget):** in `dashboard/index.tsx`, make each low-stock row a `TouchableOpacity` navigating to the item detail (`router.push({ pathname: '/(app)/(inventory)/[id]', params: { id: item.id } })`); restyle the widget header/accent to `colors.accent` (orange). If `getLowStockItems().length > 3`, show a `+N more` line below the 3 rows (compute the full length: `const all = getLowStockItems(); const shown = all.slice(0,3);`).
- [ ] **Step 3 (UX — logs All-Activity):** add pull-to-refresh to the All-Activity FlatList (canonical snippet; `reloadLocalData` re-runs the server fetch) and, on `serverError`, render `<ErrorView message={serverError} onRetry={refetch} />` so there's a retry affordance.
- [ ] **Step 4 (Onboarding — `'?'` re-show):** wire a header `'?'` button. In the screens that render `<TooltipHint>`, capture the reshow fn via `onReady`; the simplest app-wide approach: have the dashboard pass `onReady={fn => setReshow(() => fn)}` and render a small `'?'` `TouchableOpacity` in its own header area that calls it. (Scope the `'?'` to the dashboard for this slice; other screens keep first-visit-only hints. Render `<TooltipHint screenKey="logs" />` on the logs screen.)
- [ ] **Step 5 (controller): verify** clean. **Step 6 (controller): commit** `feat(polish): dashboard/logs slice — theme + brand header + low-stock + logs PTR/retry + '?'`.

### Task 10 (S8 — MoveStockModal)
**Files:** Modify `src/components/MoveStockModal.tsx`
- [ ] **Step 1:** Apply the shared transform (tokens + primitives); migrate its `<Modal>` shell to `<ModalSheet>` (close preserves the selected destination/qty).
- [ ] **Step 2 (UX — confirm):** wrap the actual move in `confirmDestructive`. In `handleConfirm` (`:77`), instead of executing the move directly, call:
```tsx
confirmDestructive({
  title: 'Move stock?',
  message: `Move ${qty} ${unitLabel} from ${fromName} to ${toName}? This updates stock at both locations.`,
  confirmLabel: 'Move',
  onConfirm: () => { /* the existing move body */ },
});
```
(The implementer pulls the existing move body into `onConfirm`; uses the real variable names for qty/locations.)
- [ ] **Step 3 (controller): verify** clean. **Step 4 (controller): commit** `feat(polish): MoveStockModal — theme + ModalSheet + destructive confirm`.

---

# SHIP (controller, after all slices merge)
- [ ] Mobile-wide `npx tsc --noEmit` clean. Grep guard: `grep -rE "#2563EB|#1D4ED8|#1E3A5F" apps/mobile/app apps/mobile/src` → zero hits (no leftover blue/navy). Whole-branch review (opus, `merge-base..HEAD`).
- [ ] Merge `feat/polish-pass` → `main`. JS-only → reaches the dev client via Metro reload; **rebuild the release APK** (no native change → dev-client rebuild not required, but APK should carry it). iOS EAS build deferred (user).
- [ ] Manual spot-check on device: SERVPRO green/orange everywhere (no blue); pull-to-refresh on each list spins+syncs+reloads; modals dismiss on outside-tap preserving inputs; Move-Stock confirms; users-create spins; settings sync surfaces errors; low-stock rows navigate; first-visit hints show on the 7 screens; maintenance banner is orange.

## Self-Review (controller checklist)
- **Spec coverage:** Unit0→T1+T2; S1→T3; S2→T4; S3→T5; S4→T6; S5→T7; S6→T8; S7→T9; S8→T10. Palette, primitives, PTR, confirms, loading/error, onboarding, modal-rule, header rebrand all mapped. ✔
- **Placeholder scan:** foundation code is literal; slice steps name the exact UX-fix code; "shared transform" is defined once and referenced (not vague). Implementers read each file (mechanical substitution varies per file — unavoidable, bounded).
- **Type consistency:** primitive prop types (T1) and helper signatures (T2) are consumed verbatim by slices; `syncNow()`/`RefreshControl`/`confirmDestructive`/`getAppSetting` names match.
- **File-collision check:** T1 (theme+ui/*), T2 (confirm+appSettings+TooltipHint+hints) disjoint → parallel. S1–S8 each own a distinct screen group; `_layout.tsx` only in S7; `MoveStockModal` only in S8; `hints.ts` only in T2 (slices render, don't edit it). All Wave-1 slices disjoint → parallel. ✔
- **Note:** slices are larger than a single-function task but each is one cohesive reviewer gate (one screen group, one verdict). If a slice's review surfaces a missed divergence, the fix is local to that slice.
