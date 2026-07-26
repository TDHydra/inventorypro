# Gas Receipts (#168) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Session directive (2026-07-23):** implement TOGETHER in the main session — superpowers:executing-plans inline; subagents only for research/docs.

**Goal:** Gas-receipt capture on vehicles: a dedicated FormSheet (photo + required payer + vehicle + mileage + optional job), reachable from the vehicle page and QuickAdd, plus the admin payer-list editor.

**Architecture:** A receipt IS a `fuel_up` service record (`createServiceRecord` gained `payer`/`jobId` in phase 0) with optional media (`entity_type='service_record'`). New `GasReceiptSheet` writes the record first (offline-first), then uploads the photo (online-only presigned PUT). Payer list lives in `app_config` via the existing `gasReceiptPayers` module; the editor mirrors `hidden-fields.tsx`.

**Tech Stack:** Expo SDK 56 / React Native, FormSheet kit, expo-image-picker, `uploadMediaAsset` (native + .web twin), node:test + tsx.

**Spec:** `docs/superpowers/specs/2026-07-25-gas-receipts-design.md`.

## Global Constraints

- **No migrations** — phase 0 (70d2fca) shipped `payer`/`job_id` columns and `service_record` media end-to-end.
- **Reuse the kit** (user directive): FormSheet, SearchablePicker, StatusPill, DateField, TextField, FieldLabel, confirmSheet, QuickAddScreenShell. No hand-rolled surfaces.
- Exact copy: button `+ Gas receipt`; sheet title `Gas Receipt`; payer pills from `getGasReceiptPayers()`; no-photo confirm `No receipt photo attached — save anyway?`; admin row `⛽ Gas Receipt Payers`.
- **Never `git add -A`** (`.claude/skills/board/*` + `start-metro/` are deliberate dirty state). Stage exact paths.
- Branch `gas-receipts` off main; Metro serves the main checkout — don't edit while the user device-tests.
- Mobile commands run in `apps/mobile`: suite `pnpm test` (593 baseline), typecheck `pnpm exec tsc --noEmit`.
- Commits: `feat(#168): ...` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.

---

### Task 0: Branch setup

**Files:** none (git only)

- [ ] **Step 1:**

```bash
cd /home/tdpotato/projects/InventoryPro
git fetch origin && git status    # on main, clean apart from known .claude/skills dirty files
git checkout -b gas-receipts
```

---

### Task 1: Pure logic — vehicle-mismatch note (TDD)

**Files:**
- Modify: `apps/mobile/src/components/vehicles/vehicleSessionLogic.ts` (append)
- Test: `apps/mobile/src/components/vehicles/vehicleSessionLogic.test.ts` (append)

**Interfaces:**
- Produces: `buildReceiptVehicleMismatchNote(checkedOutName: string, chosenName: string): string` — Task 3 passes its output as `logNote` (Task 2).

- [ ] **Step 1: Failing tests** — append to `vehicleSessionLogic.test.ts` (add `buildReceiptVehicleMismatchNote` to the import block):

```ts
// ── #168: receipt logged against a different vehicle than the active checkout
test('buildReceiptVehicleMismatchNote names both vehicles', () => {
  assert.equal(
    buildReceiptVehicleMismatchNote('Van 1', 'Box Truck'),
    'fuel_up receipt: user checked out Van 1 but logged against Box Truck',
  );
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd apps/mobile
node --import tsx --import ./src/test/setupGlobals.mjs --test src/components/vehicles/vehicleSessionLogic.test.ts
```

Expected: FAIL — not exported.

- [ ] **Step 3: Implement** — append to `vehicleSessionLogic.ts`:

```ts
/**
 * #168: the user has a vehicle checked out but filed the gas receipt against a
 * different one — allowed, but the mismatch is recorded in the activity log.
 */
export function buildReceiptVehicleMismatchNote(checkedOutName: string, chosenName: string): string {
  return `fuel_up receipt: user checked out ${checkedOutName} but logged against ${chosenName}`;
}
```

- [ ] **Step 4: Re-run** (same command). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/vehicles/vehicleSessionLogic.ts src/components/vehicles/vehicleSessionLogic.test.ts
git commit -m "feat(#168): receipt vehicle-mismatch log note builder

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `createServiceRecord` optional `logNote`

**Files:**
- Modify: `apps/mobile/src/db/queries/vehicles.ts` (`createServiceRecord`, ~line 209)

**Interfaces:**
- Produces: `createServiceRecord` input gains `logNote?: string | null`; the activity-log `note` becomes `input.logNote ?? input.type`. All existing callers unchanged (param optional).

- [ ] **Step 1: Add the param.** In the input type add:

```ts
  logNote?: string | null; // #168: overrides the activity-log note (vehicle-mismatch receipts)
```

and in the `appendLog({...})` call inside change `note: input.type,` to:

```ts
      note: input.logNote ?? input.type,
```

- [ ] **Step 2: Verify** — `pnpm exec tsc --noEmit && pnpm test` → clean, 594+ pass (Task 1 added 1).

- [ ] **Step 3: Commit**

```bash
git add src/db/queries/vehicles.ts
git commit -m "feat(#168): createServiceRecord accepts a logNote override

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `GasReceiptSheet`

**Files:**
- Create: `apps/mobile/src/components/vehicles/GasReceiptSheet.tsx`

**Interfaces:**
- Consumes: `buildReceiptVehicleMismatchNote` (Task 1), `createServiceRecord({ ..., payer, jobId, logNote })` (Task 2), `getActiveCheckoutForUser(userId): (VehicleCheckout & { vehicle_name: string }) | null`, `getUnitLocations('Vehicle')` (from `db/queries/locations` — active vehicles), `getGasReceiptPayers/subscribeGasReceiptPayers/getGasReceiptPayersVersion`, `uploadMediaAsset(input: UploadMediaInput)` + `MediaTooLargeError` (`src/media/upload`), `getOpenJobs(): Job[]`, `SearchablePicker`/`PickerOption`, `FormSheet`, `confirmSheet`, `buildFuelUpNotes`, `FUEL_UP_TYPE`.
- Produces: `<GasReceiptSheet visible onClose lockedVehicleId?: string />` — Task 4 mounts it in two places.

- [ ] **Step 1: Create the component**

```tsx
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from '../../lib/themedAlert';
import { FormSheet } from '../ui/FormSheet';
import { TextField } from '../ui/TextField';
import { DateField } from '../ui/DateField';
import { FieldLabel } from '../ui/FieldLabel';
import { StatusPill } from '../ui/StatusPill';
import { PrimaryButton } from '../ui/PrimaryButton';
import { confirmSheet } from '../ui/ConfirmSheet';
import { SearchablePicker, type PickerOption } from '../SearchablePicker';
import {
  createServiceRecord, getActiveCheckoutForUser,
} from '../../db/queries/vehicles';
import { getUnitLocations, getLocationById } from '../../db/queries/locations';
import { getOpenJobs } from '../../db/queries/jobs';
import {
  getGasReceiptPayers, subscribeGasReceiptPayers, getGasReceiptPayersVersion,
} from '../../db/gasReceiptPayers';
import { FUEL_UP_TYPE, buildFuelUpNotes, buildReceiptVehicleMismatchNote } from './vehicleSessionLogic';
import { uploadMediaAsset, MediaTooLargeError } from '../../media/upload';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { isWriteBlocked } from '../../db/maintenance';
import {
  parseOptionalCount, parseOptionalDate, parseOptionalNonNegative, validateText,
} from '../../lib/validation';
import { track } from '../../telemetry';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

const today = () => new Date().toISOString().slice(0, 10);

interface PickedPhoto {
  uri: string;
  ext: string;      // lowercase, no dot
  size?: number;    // bytes when the picker reports it
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Vehicle-page entry: vehicle fixed to this location, no picker. */
  lockedVehicleId?: string;
}

/**
 * #168 gas receipt: a fuel_up service record (payer REQUIRED, photo nudged-
 * optional) + optional service_record media. Vehicle defaults to the caller's
 * active checkout; picking a different one is allowed but logged
 * (buildReceiptVehicleMismatchNote). The record commits offline-first; the
 * photo upload is online-only — failure never rolls back the record.
 */
export function GasReceiptSheet({ visible, onClose, lockedVehicleId }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const canViewFinancial = usePermission('view_financial_data');

  // Live payer list — settings edits show without remount (hiddenFields pattern).
  const payersVersion = useSyncExternalStore(subscribeGasReceiptPayers, getGasReceiptPayersVersion, getGasReceiptPayersVersion);
  const payers = useMemo(() => getGasReceiptPayers(), [payersVersion]);

  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [payer, setPayer] = useState<string | null>(null);
  const [vehicle, setVehicle] = useState<PickerOption | null>(null);
  const [job, setJob] = useState<PickerOption | null>(null);
  const [gallons, setGallons] = useState('');
  const [date, setDate] = useState(today);
  const [odometer, setOdometer] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // The active checkout at open time — the default vehicle AND the mismatch baseline.
  const [activeCheckout, setActiveCheckout] = useState<{ id: string; name: string } | null>(null);

  const vehicleOptions = useMemo<PickerOption[]>(
    () => (lockedVehicleId ? [] : getUnitLocations('Vehicle').map(l => ({ id: l.id, label: l.name }))),
    [visible, lockedVehicleId],
  );
  const jobOptions = useMemo<PickerOption[]>(
    () => getOpenJobs().map(j => ({ id: j.id, label: j.name })),
    [visible],
  );

  // Fresh form each open (sheet stays mounted while hidden).
  useEffect(() => {
    if (!visible) return;
    setPhoto(null); setPayer(null); setJob(null);
    setGallons(''); setDate(today()); setOdometer(''); setCost(''); setNotes('');
    if (lockedVehicleId) {
      const loc = getLocationById(lockedVehicleId);
      setVehicle(loc ? { id: loc.id, label: loc.name } : null);
      setActiveCheckout(null); // fixed vehicle — mismatch logging n/a
    } else if (user?.id) {
      const active = getActiveCheckoutForUser(user.id);
      setActiveCheckout(active ? { id: active.vehicle_location_id, name: active.vehicle_name } : null);
      setVehicle(active ? { id: active.vehicle_location_id, label: active.vehicle_name } : null);
    } else {
      setActiveCheckout(null); setVehicle(null);
    }
  }, [visible, lockedVehicleId, user?.id]);

  const dirty =
    photo != null || payer != null || gallons.trim().length > 0 ||
    odometer.trim().length > 0 || cost.trim().length > 0 || notes.trim().length > 0 ||
    job != null;

  function reject(field: string, rule: string) {
    track('audit', 'validation_reject', { screen: 'gas_receipt', props: { field, rule } });
  }

  async function pickPhoto(fromCamera: boolean) {
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.8 };
    const res = fromCamera
      ? await ImagePicker.launchCameraAsync(opts)
      : await ImagePicker.launchImageLibraryAsync(opts);
    if (res.canceled || !res.assets?.[0]) return;
    const a = res.assets[0];
    const ext = (a.fileName?.split('.').pop() ?? a.uri.split('.').pop() ?? 'jpg').toLowerCase();
    setPhoto({ uri: a.uri, ext: ext === 'jpeg' ? 'jpg' : ext, size: a.fileSize ?? undefined });
  }

  async function submit() {
    if (isWriteBlocked()) return;
    if (!vehicle) { reject('gas_receipt.vehicle', 'required'); Alert.alert('Required', 'Pick a vehicle.'); return; }
    if (!payer) { reject('gas_receipt.payer', 'required'); Alert.alert('Required', "Pick who it's for."); return; }
    const gallonsResult = parseOptionalNonNegative(gallons, 'Gallons');
    if (!gallonsResult.ok) { reject('gas_receipt.gallons', gallonsResult.rule); Alert.alert('Invalid gallons', gallonsResult.error); return; }
    const dateResult = parseOptionalDate(date, 'Date');
    if (!dateResult.ok) { reject('gas_receipt.event_date', dateResult.rule); Alert.alert('Invalid date', dateResult.error); return; }
    const odoResult = parseOptionalCount(odometer, 'Odometer');
    if (!odoResult.ok) { reject('gas_receipt.odometer', odoResult.rule); Alert.alert('Invalid odometer', odoResult.error); return; }
    const notesResult = validateText(notes, { label: 'Notes' });
    if (!notesResult.ok) { reject('gas_receipt.notes', notesResult.rule); Alert.alert('Invalid notes', notesResult.error); return; }
    let costValue: number | null = null;
    if (canViewFinancial) {
      const costResult = parseOptionalNonNegative(cost, 'Cost');
      if (!costResult.ok) { reject('gas_receipt.cost', costResult.rule); Alert.alert('Invalid cost', costResult.error); return; }
      costValue = costResult.value;
    }
    // Nudged-optional photo: one confirm, never a block.
    if (!photo) {
      const ok = await confirmSheet({
        title: 'No receipt photo attached — save anyway?',
        message: 'The office reimburses against the photo. You can still save without one.',
        confirmLabel: 'Save Anyway',
      });
      if (!ok) return;
    }

    // #168: picking a different vehicle than the active checkout is allowed but logged.
    const mismatch = activeCheckout != null && activeCheckout.id !== vehicle.id;
    const logNote = mismatch
      ? buildReceiptVehicleMismatchNote(activeCheckout!.name, vehicle.label)
      : null;

    setBusy(true);
    try {
      const recordId = createServiceRecord({
        vehicleLocationId: vehicle.id,
        target: 'vehicle',
        eventDate: dateResult.value ?? new Date().toISOString(),
        type: FUEL_UP_TYPE,
        notes: buildFuelUpNotes(gallonsResult.value, notesResult.value),
        odometer: odoResult.value,
        cost: costValue,
        payer,
        jobId: job?.id ?? null,
        logNote,
        userId: user?.id ?? null,
      });
      // Record is committed — the upload can fail without losing anything.
      if (photo && user?.id) {
        try {
          await uploadMediaAsset({
            entityType: 'service_record',
            entityId: recordId,
            mediaType: 'image',
            ext: photo.ext,
            uri: photo.uri,
            size: photo.size,
            userId: user.id,
          });
        } catch (err) {
          Alert.alert(
            'Receipt saved — photo not uploaded',
            err instanceof MediaTooLargeError
              ? 'That photo is over 25 MB.'
              : 'Could not upload the photo (offline?). The receipt was saved without it.',
          );
        }
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Gas Receipt"
      dirty={dirty}
      busy={busy}
      onSubmit={() => { void submit(); }}
    >
      <View style={s.fields}>
        <View>
          <FieldLabel>Receipt photo</FieldLabel>
          {photo ? (
            <View style={s.photoRow}>
              <Image source={{ uri: photo.uri }} style={s.thumb} />
              <Pressable onPress={() => setPhoto(null)} hitSlop={8}>
                <Text style={s.remove}>Remove</Text>
              </Pressable>
            </View>
          ) : (
            <View style={s.photoButtons}>
              <PrimaryButton label="📷 Camera" onPress={() => { void pickPhoto(true); }} />
              <PrimaryButton label="🖼 Library" tone="neutral" onPress={() => { void pickPhoto(false); }} />
            </View>
          )}
        </View>
        <View>
          <FieldLabel>Who is it for? *</FieldLabel>
          <View style={s.chipRow}>
            {payers.map(p => (
              <Pressable key={p} onPress={() => setPayer(p)}>
                <StatusPill label={p} tone={payer === p ? 'primary' : 'neutral'} />
              </Pressable>
            ))}
          </View>
        </View>
        <View>
          <FieldLabel>Vehicle *</FieldLabel>
          {lockedVehicleId ? (
            <Text style={s.fixedVehicle}>{vehicle?.label ?? '—'}</Text>
          ) : (
            <SearchablePicker
              placeholder="Search vehicles..."
              options={vehicleOptions}
              value={vehicle}
              onSelect={opt => setVehicle(opt)}
            />
          )}
          {activeCheckout && vehicle && activeCheckout.id !== vehicle.id && (
            <Text style={s.mismatch}>You have {activeCheckout.name} checked out — this will be noted.</Text>
          )}
        </View>
        <TextField label="Gallons (optional)" value={gallons} onChangeText={setGallons} placeholder="e.g. 12.5" keyboardType="numeric" />
        <DateField label="Date" value={date} onChange={setDate} />
        <TextField label="Mileage (optional)" value={odometer} onChangeText={setOdometer} placeholder="e.g. 84200" keyboardType="numeric" />
        <View>
          <FieldLabel>Job (optional)</FieldLabel>
          <SearchablePicker
            placeholder="Search open jobs..."
            options={jobOptions}
            value={job}
            onSelect={opt => setJob(prev => prev?.id === opt.id ? null : opt)}
          />
        </View>
        {canViewFinancial && (
          <TextField label="Cost (optional)" value={cost} onChangeText={setCost} placeholder="0.00" keyboardType="numeric" />
        )}
        <TextField label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Notes" multiline />
      </View>
    </FormSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  fields: { gap: t.spacing.md, paddingBottom: t.spacing.sm },
  photoButtons: { flexDirection: 'row', gap: t.spacing.md },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  thumb: { width: 72, height: 72, borderRadius: t.radii.md, backgroundColor: t.colors.surfaceAlt },
  remove: { color: t.colors.danger, fontWeight: '600', fontSize: t.typography.fontSizes.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  fixedVehicle: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.textPrimary },
  mismatch: { fontSize: t.typography.fontSizes.xs, color: t.colors.warningText, marginTop: t.spacing.xs },
});
```

- [ ] **Step 2: Verify** — `pnpm exec tsc --noEmit && pnpm test` → clean/green.
  (If `getUnitLocations` isn't exported with a kind filter, check its signature in `src/db/queries/locations.ts` — it's the same helper `getVisibleUnits` uses (`getUnitLocations(kind)`); adjust the call if it takes no args and filter by `type === 'Vehicle'`.)

- [ ] **Step 3: Commit**

```bash
git add src/components/vehicles/GasReceiptSheet.tsx
git commit -m "feat(#168): GasReceiptSheet — photo + payer + vehicle + job receipt form

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Entry points — service log button + QuickAdd

**Files:**
- Modify: `apps/mobile/src/components/vehicles/ServiceRecordList.tsx`
- Create: `apps/mobile/src/components/quickadd/GasReceiptQuickAdd.tsx`
- Create: `apps/mobile/app/(app)/(quickadd)/gas-receipt.tsx`
- Modify: `apps/mobile/app/(app)/(quickadd)/index.tsx` (ACTIONS array)

**Interfaces:**
- Consumes: `GasReceiptSheet` (Task 3).

- [ ] **Step 1: Vehicle-page button.** In `ServiceRecordList.tsx`, import the sheet and add state + a second button. The gas-receipt button is deliberately NOT `canEdit`-gated (crew-level write, like tank state):

```tsx
import { GasReceiptSheet } from './GasReceiptSheet';
```

```tsx
  const [receiptOpen, setReceiptOpen] = useState(false);
```

Replace the single `{canEdit && (<TouchableOpacity ...+ Log service...)}` block with a row of two buttons:

```tsx
        <View style={s.btnRow}>
          {canEdit && (
            <TouchableOpacity style={s.addBtn} onPress={() => setAddOpen(true)} disabled={locked}>
              <Text style={s.addText}>+ Log service</Text>
            </TouchableOpacity>
          )}
          {/* #168: ungated — any crew member files a gas receipt. */}
          <TouchableOpacity style={s.addBtn} onPress={() => setReceiptOpen(true)} disabled={locked}>
            <Text style={s.addText}>+ Gas receipt</Text>
          </TouchableOpacity>
        </View>
```

mount beside the existing sheet:

```tsx
      <GasReceiptSheet
        visible={receiptOpen}
        onClose={() => setReceiptOpen(false)}
        lockedVehicleId={locationId}
      />
```

and add to styles: `btnRow: { flexDirection: 'row', gap: t.spacing.sm, marginTop: t.spacing.sm },` (remove `marginTop` from `addBtn` so the row spaces them).

- [ ] **Step 2: QuickAdd wrapper** — `src/components/quickadd/GasReceiptQuickAdd.tsx`:

```tsx
import { useState } from 'react';
import { GasReceiptSheet } from '../vehicles/GasReceiptSheet';

/**
 * QuickAdd host for the gas-receipt sheet (#168): the hub route mounts this,
 * the sheet opens immediately, and closing it pops back to the launcher.
 */
export default function GasReceiptQuickAdd({ onSaved }: { onSaved: (name: string, id?: string) => void }) {
  const [open, setOpen] = useState(true);
  return (
    <GasReceiptSheet
      visible={open}
      onClose={() => { setOpen(false); onSaved('Gas receipt'); }}
    />
  );
}
```

- [ ] **Step 3: Route** — `app/(app)/(quickadd)/gas-receipt.tsx` (repair.tsx pattern):

```tsx
import GasReceiptQuickAdd from '../../../src/components/quickadd/GasReceiptQuickAdd';
import { QuickAddScreenShell } from '../../../src/components/quickadd/QuickAddScreenShell';

export default function QuickAddGasReceiptScreen() {
  return (
    <QuickAddScreenShell title="Quick Add — Gas Receipt" wrapForm={false}>
      {onSaved => <GasReceiptQuickAdd onSaved={onSaved} />}
    </QuickAddScreenShell>
  );
}
```

- [ ] **Step 4: Hub tile** — in `app/(app)/(quickadd)/index.tsx` ACTIONS, after the vehicle row:

```tsx
  { route: '/(app)/(quickadd)/gas-receipt', icon: '⛽', label: 'Gas Receipt', sub: 'Photo + payer + mileage' },
```

- [ ] **Step 5: Verify** — `pnpm exec tsc --noEmit && pnpm test` → clean/green.
  (Check `QuickAddScreenShell`'s `onSaved` signature — if it expects `(name: string, id?: string)`, the wrapper above matches; adjust if it differs.)

- [ ] **Step 6: Commit**

```bash
git add src/components/vehicles/ServiceRecordList.tsx src/components/quickadd/GasReceiptQuickAdd.tsx "app/(app)/(quickadd)/gas-receipt.tsx" "app/(app)/(quickadd)/index.tsx"
git commit -m "feat(#168): gas-receipt entry points — service log button + QuickAdd tile

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Payer settings editor

**Files:**
- Create: `apps/mobile/app/(app)/(admin)/gas-receipt-payers.tsx`
- Modify: `apps/mobile/app/(app)/(admin)/settings.tsx` (nav row after the Hidden Fields section, ~line 928)

**Interfaces:**
- Consumes: `getGasReceiptPayers/setGasReceiptPayers/notifyGasReceiptPayersChanged`, `subscribeGasReceiptPayers/getGasReceiptPayersVersion`, `appendLog` (`src/db/queries/log` — `entity_type: 'app_config'`, `entity_id: null`; activity_log entity_id is UUID-typed, string keys crash the push), `runInTransaction`.

- [ ] **Step 1: The screen** — `app/(app)/(admin)/gas-receipt-payers.tsx` (mirrors `hidden-fields.tsx`):

```tsx
import { useMemo, useState, useSyncExternalStore } from 'react';
import { View, Text, ScrollView, Pressable, StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { Alert } from '../../../src/lib/themedAlert';
import { usePermission } from '../../../src/hooks/usePermission';
import { useSession } from '../../../src/hooks/useSession';
import { TextField } from '../../../src/components/ui/TextField';
import { PrimaryButton } from '../../../src/components/ui/PrimaryButton';
import {
  getGasReceiptPayers, setGasReceiptPayers, notifyGasReceiptPayersChanged,
  subscribeGasReceiptPayers, getGasReceiptPayersVersion,
} from '../../../src/db/gasReceiptPayers';
import { appendLog } from '../../../src/db/queries/log';
import { runInTransaction } from '../../../src/db/tx';
import { isWriteBlocked } from '../../../src/db/maintenance';
import type { Theme } from '../../../src/themes/types';
import { useThemedStyles } from '../../../src/hooks/useThemedStyles';

// #168: who a gas receipt can be charged to. Synced via app_config (code
// default when absent — never migration-seeded). system_settings-gated like
// hidden-fields.tsx; every mutation logs + notifies subscribers so open
// receipt forms update live.
export default function GasReceiptPayersScreen() {
  const s = useThemedStyles(makeStyles);
  const isAdmin = usePermission('system_settings');
  const { user } = useSession();
  const version = useSyncExternalStore(subscribeGasReceiptPayers, getGasReceiptPayersVersion, getGasReceiptPayersVersion);
  const payers = useMemo(() => getGasReceiptPayers(), [version]);
  const [draft, setDraft] = useState('');
  // Non-null while renaming an existing entry (holds the original value).
  const [editing, setEditing] = useState<string | null>(null);

  function commit(next: string[], note: string) {
    if (isWriteBlocked()) return;
    try {
      runInTransaction(() => {
        setGasReceiptPayers(next);
        appendLog({
          action: 'gas_receipt_payers_changed',
          entity_type: 'app_config',
          entity_id: null, // UUID column — string keys here break the push
          user_id: user?.id ?? null,
          note,
          team_id: null, job_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, metadata: JSON.stringify({ payers: next }), device_id: null,
        });
      });
    } catch (e) {
      Alert.alert('Could not save payers', e instanceof Error ? e.message : 'Not saved. Try again.');
      return;
    }
    notifyGasReceiptPayersChanged();
    setDraft('');
    setEditing(null);
  }

  function onSave() {
    const value = draft.trim();
    if (!value) return;
    if (payers.includes(value) && value !== editing) {
      Alert.alert('Duplicate', `"${value}" is already in the list.`);
      return;
    }
    const next = editing
      ? payers.map(p => (p === editing ? value : p))
      : [...payers, value];
    commit(next, editing ? `renamed ${editing} → ${value}` : `added ${value}`);
  }

  function onRemove(p: string) {
    if (payers.length <= 1) {
      Alert.alert('At least one payer required', 'The receipt form requires a payer — keep at least one.');
      return;
    }
    commit(payers.filter(x => x !== p), `removed ${p}`);
  }

  if (!isAdmin) {
    return (
      <View style={s.center}>
        <Stack.Screen options={{ title: 'Gas Receipt Payers', headerShown: true }} />
        <Text style={s.muted}>You don’t have access to gas receipt payers.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={s.screen} contentContainerStyle={s.content}>
      <Stack.Screen options={{ title: 'Gas Receipt Payers', headerShown: true }} />
      <Text style={s.caption}>
        Who a gas receipt can be charged to. Applies to all users on all devices; existing
        receipts keep the name they were saved with.
      </Text>
      {payers.map(p => (
        <View key={p} style={s.row}>
          <Pressable style={s.rowMain} onPress={() => { setEditing(p); setDraft(p); }}>
            <Text style={s.rowLabel}>{p}{editing === p ? '  (editing…)' : ''}</Text>
          </Pressable>
          <Pressable onPress={() => onRemove(p)} hitSlop={8}>
            <Text style={s.remove}>✕</Text>
          </Pressable>
        </View>
      ))}
      <TextField
        label={editing ? `Rename "${editing}"` : 'Add payer'}
        value={draft}
        onChangeText={setDraft}
        placeholder="e.g. Warehouse"
      />
      <PrimaryButton label={editing ? 'Save Rename' : 'Add'} onPress={onSave} disabled={!draft.trim()} />
      {editing && (
        <PrimaryButton label="Cancel Rename" tone="neutral" onPress={() => { setEditing(null); setDraft(''); }} />
      )}
    </ScrollView>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: t.colors.background },
  content: { padding: t.spacing.base, gap: t.spacing.md, paddingBottom: 48 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.spacing.xl },
  muted: { color: t.colors.textMuted },
  caption: { fontSize: t.typography.fontSizes.sm, color: t.colors.textSecondary, lineHeight: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: t.colors.surface, borderRadius: t.radii.md,
    borderWidth: 1, borderColor: t.colors.border,
    paddingHorizontal: t.spacing.base, paddingVertical: t.spacing.md,
  },
  rowMain: { flex: 1 },
  rowLabel: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.textPrimary },
  remove: { color: t.colors.danger, fontSize: t.typography.fontSizes.lg, paddingHorizontal: t.spacing.sm },
});
```

- [ ] **Step 2: Nav row** — in `app/(app)/(admin)/settings.tsx`, directly after the Hidden Fields section's closing `)}` (~line 928), add:

```tsx
        {/* ── Gas Receipt Payers (#168 — synced via app_config) ────────── */}
        {isAdmin && (
          <View>
            <Text style={s.sectionTitle}>Gas Receipts</Text>
            <View style={s.card}>
              <TouchableOpacity
                style={s.row}
                onPress={() => router.push('/(app)/(admin)/gas-receipt-payers')}
              >
                <View style={{ flex: 1 }}>
                  <Text style={s.rowLabel}>⛽ Gas Receipt Payers</Text>
                  <Text style={s.rowSub}>Who receipts can be charged to.</Text>
                </View>
                <Text style={s.rowSub}>›</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
```

- [ ] **Step 3: Verify** — `pnpm exec tsc --noEmit && pnpm test` → clean/green.

- [ ] **Step 4: Commit**

```bash
git add "app/(app)/(admin)/gas-receipt-payers.tsx" "app/(app)/(admin)/settings.tsx"
git commit -m "feat(#168): gas-receipt payers admin editor (hidden-fields pattern)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Display — payer + photo indicator on record rows

**Files:**
- Modify: `apps/mobile/src/components/vehicles/ServiceRecordList.tsx`
- Modify: `apps/mobile/src/components/vehicles/VehicleHistoryPanel.tsx` (fuel-up rows)

**Interfaces:**
- Consumes: `getMediaForEntity(entityType, entityId): MediaRecord[]` (`src/db/queries/media`).

- [ ] **Step 1: ServiceRecordList rows.** Add the import, subscribe to media changes, and extend the row:

```tsx
import { getMediaForEntity } from '../../db/queries/media';
```

change the version line to include media:

```tsx
  const version = useTableVersion(['vehicle_service_records', 'media']);
```

and inside the record `map`, after the `rowTitle` Text, extend the header with a photo marker, and add the payer subtitle after the odometer line:

```tsx
                  {getMediaForEntity('service_record', r.id).length > 0 && (
                    <Text style={s.rowSub}>📷</Text>
                  )}
```

```tsx
                {!!r.payer && <Text style={s.rowSub}>For: {r.payer}</Text>}
```

- [ ] **Step 2: VehicleHistoryPanel fuel-ups.** Open the file; in the fuel-up row render (it maps `getFuelUps(...)`), add the same payer line after the existing sublines:

```tsx
                {!!f.payer && <Text style={s.subline}>For: {f.payer}</Text>}
```

(match the file's actual subline style name — read the surrounding rows first; `VehicleServiceRecord.payer` is already on the type.)

- [ ] **Step 3: Verify** — `pnpm exec tsc --noEmit && pnpm test` → clean/green.

- [ ] **Step 4: Commit**

```bash
git add src/components/vehicles/ServiceRecordList.tsx src/components/vehicles/VehicleHistoryPanel.tsx
git commit -m "feat(#168): show payer + photo marker on service/fuel-up rows

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification + hotload device pass

**Files:** none

- [ ] **Step 1: Suites**

```bash
cd /home/tdpotato/projects/InventoryPro/apps/mobile && pnpm exec tsc --noEmit && pnpm test
cd /home/tdpotato/projects/InventoryPro/apps/api && pnpm exec tsc --noEmit && pnpm test
```

Expected: mobile ≥594 (593 + Task 1), API 417/417, tsc clean. API untouched — regression canary.

- [ ] **Step 2: Hotload** — `start-metro` skill; confirm metro.log "Starting project at" points at the main worktree on `gas-receipts`.

- [ ] **Step 3: Device checklist with the user** (no code edits while they test):
  - Receipt from the vehicle page: vehicle fixed, payer required (save blocked without), photo optional with the "save anyway?" confirm, record appears in the service log with "For: <payer>" + 📷.
  - Receipt from QuickAdd: vehicle defaults to the active checkout; picking a different vehicle shows the mismatch caption and lands the log note (check audit log).
  - Payer editor: `system_settings` user adds/renames/removes; open receipt form updates live; min-1 guard fires.
  - Offline: airplane-mode save → record persists, photo-failure alert, record syncs later.
  - Expo Web sanity: sheet opens, library picker works (`upload.web.ts` path).

- [ ] **Step 4: Fix-forward + re-run Step 1; commit fixes as `fix(#168): ...`.**

---

### Task 8: Merge + board

- [ ] **Step 1:** superpowers:finishing-a-development-branch — repo pattern: fast-forward merge to `main`, push, delete branch.
- [ ] **Step 2:** After user device confirmation: `gh_done.py 168` (board skill). #168 is the last In-progress vehicle item; remaining vehicle work = #174/#175 (wave 3) + #176 (server guard), all Backlog.
- [ ] **Step 3:** Deploy reminder: prod ship still pending for ALL vehicle waves (API auto-applies 065/066; open_checkout day-one availability change; release APK predates everything — warn the crew when shipping).

---

## Self-Review (done at write time)

- **Spec coverage:** §1 sheet → Tasks 1–3; §2 entry points → Task 4; §3 settings editor → Task 5; §4 display → Task 6; §5 testing → Tasks 1/7. Offline-photo behavior matches the corrected spec (record saves, upload may fail with alert).
- **Placeholder scan:** two deliberate verify-at-execution notes (getUnitLocations arg shape, QuickAddScreenShell onSaved signature, VehicleHistoryPanel subline style name) — each states exactly what to check and where; no TBDs.
- **Type consistency:** `GasReceiptSheet` props identical in Tasks 3/4; `buildReceiptVehicleMismatchNote(checkedOutName, chosenName)` identical in Tasks 1/3; `logNote` param identical in Tasks 2/3; `getMediaForEntity('service_record', r.id)` matches the queries/media signature.
