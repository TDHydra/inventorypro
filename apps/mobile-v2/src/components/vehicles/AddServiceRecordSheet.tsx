import { useEffect, useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import {
  Alert, FormSheet, SegmentedControl, TextField, DateField, FieldLabel, useThemedStyles, type Theme,
} from '@invenpro/ui';
import { runInTransaction, useTableVersion } from '@invenpro/core';
import { SearchablePicker, type PickerOption } from '../SearchablePicker';
import { createServiceRecord, getActiveCheckoutForUser, type ServiceTarget } from '../../repos/vehicles';
import { getUnitLocations, getLocationById } from '../../repos/locations';
import { getOpenJobs, upsertJob, type Job } from '../../repos/jobs';
import { getAllTeams } from '../../repos/teams';
import { getPayerTypes } from '../../repos/taxonomy';
import { FUEL_UP_TYPE, buildFuelUpNotes, buildReceiptVehicleMismatchNote } from './vehicleSessionLogic';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { isWriteBlocked } from '../../db/maintenance';
import { appendLog } from '../../db/queries/log';
import { generateUUID } from '../../utils/uuid';
import {
  parseOptionalCount, parseOptionalDate, parseOptionalNonNegative, validateText,
} from '../../lib/validation';
import { track } from '../../telemetry';

// FormSheet field set mirrors the equipment Log Maintenance modal, plus the
// vehicle-specific `target` segment (which part was serviced) and an
// optional odometer reading.
//
// #168 grew the Fuel-up branch into the gas receipt (user decision: ONE form,
// not a parallel sheet — see the memory rule this station's brief called
// out): a REQUIRED "For": a Payer ('payer' taxonomy — Office etc.), a Team,
// or a Job (open jobs). payer stores the chosen name as a TEXT snapshot; job
// receipts also set job_id. Non-editors are locked to the Fuel-up kind — any
// crew member files a receipt; service records stay edit_inventory-only.
// Without `locationId` (QuickAdd entry) a vehicle picker appears, defaulting
// to the caller's active checkout; picking a different vehicle is allowed
// but logged (buildReceiptVehicleMismatchNote).
//
// Station C3 deviation from apps/mobile: the receipt PHOTO capture (expo-
// image-picker + uploadMediaAsset) and its "no photo? save anyway" confirm
// nudge are CUT — no media module exists in mobile-v2 yet (TODO(wave-media),
// matching the Station C1 equipment-photo precedent); the nudge doesn't make
// sense without the capability it was nudging about, so it's dropped rather
// than reworded. Also: createServiceRecord no longer self-logs (Station C3's
// no-self-log conversion of repos/vehicles.ts) — submit() below builds the
// 'vehicle_service_logged' appendLog call itself, inside a runInTransaction.
const TARGET_SEGMENTS = [
  { id: 'vehicle', label: 'Vehicle' },
  { id: 'truck_mount', label: 'Truck mount' },
  { id: 'both', label: 'Both' },
];

// #141: fuel-ups are service records with type='fuel_up' (free TEXT — no
// taxonomy) and gallons folded into notes; this segment switches the form.
const KIND_SEGMENTS = [
  { id: 'service', label: 'Service' },
  { id: 'fuel_up', label: 'Fuel-up' },
];

const today = () => new Date().toISOString().slice(0, 10);

interface Props {
  /** Fixed vehicle (vehicle-page entry). Absent → vehicle picker (QuickAdd). */
  locationId?: string;
  visible: boolean;
  onClose: () => void;
  /** Starting kind — QuickAdd's ⛽ tile opens on 'fuel_up'. */
  initialKind?: 'service' | 'fuel_up';
  /** Fired after a successful save, before onClose (QuickAdd shell toast). */
  onSaved?: () => void;
}

export function AddServiceRecordSheet({ locationId, visible, onClose, initialKind = 'service', onSaved }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user, realUser } = useSession();
  const canViewFinancial = usePermission('view_financial_data');
  // #168: non-editors may only file fuel-ups/receipts (crew-level write);
  // arbitrary service records remain an editor action.
  const isEditor = usePermission('edit_inventory');
  // #173: quick-add-job on the "For" picker, same gate as the checkout/
  // DestinationPicker job pickers.
  const canCreateJobs = usePermission('create_jobs');

  const [kind, setKind] = useState<'service' | 'fuel_up'>(initialKind);
  const [target, setTarget] = useState<ServiceTarget>('vehicle');
  const [type, setType] = useState('');
  const [date, setDate] = useState(today);
  const [odometer, setOdometer] = useState('');
  const [gallons, setGallons] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  // #168 "For" — ONE dynamic search over teams + jobs (single type-ahead like
  // the rest of the app, no toggle).
  const [forPick, setForPick] = useState<PickerOption | null>(null);
  const [vehicle, setVehicle] = useState<PickerOption | null>(null);
  const [busy, setBusy] = useState(false);

  // The active checkout at open time — the default vehicle AND the mismatch baseline.
  const [activeCheckout, setActiveCheckout] = useState<{ id: string; name: string } | null>(null);

  const effectiveKind = isEditor ? kind : 'fuel_up';
  const isFuelUp = effectiveKind === 'fuel_up';

  const locationsVersion = useTableVersion(['locations']);
  const forVersion = useTableVersion(['jobs', 'teams', 'taxonomy_types']);

  const vehicleOptions: PickerOption[] = (locationId || !visible)
    ? []
    : getUnitLocations('Vehicle').map(l => ({ id: l.id, label: l.name }));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version bumps are the reactivity signal, not a real dep
  void locationsVersion;

  const forData = (() => {
    if (!visible) return { forOptions: [] as PickerOption[], jobIds: new Set<string>() };
    const payers = getPayerTypes().map(p => ({ id: p.id, label: p.label, sublabel: 'Payer' }));
    const teams = getAllTeams().map(tm => ({ id: tm.id, label: tm.name, sublabel: 'Team' }));
    const jobs = getOpenJobs().map(j => ({ id: j.id, label: j.name, sublabel: 'Job' }));
    return { forOptions: [...payers, ...teams, ...jobs], jobIds: new Set(jobs.map(j => j.id)) };
  })();
  const { forOptions, jobIds } = forData;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  void forVersion;

  // Fresh form on every open (the sheet component itself stays mounted while
  // hidden, so state would otherwise leak between opens).
  useEffect(() => {
    if (!visible) return;
    setKind(initialKind);
    setTarget('vehicle');
    setType('');
    setDate(today());
    setOdometer('');
    setGallons('');
    setCost('');
    setNotes('');
    setForPick(null);
    if (locationId) {
      const loc = getLocationById(locationId);
      setVehicle(loc ? { id: loc.id, label: loc.name } : null);
      setActiveCheckout(null); // fixed vehicle — mismatch logging n/a
    } else if (user?.id) {
      const active = getActiveCheckoutForUser(user.id);
      setActiveCheckout(active ? { id: active.vehicle_location_id, name: active.vehicle_name } : null);
      setVehicle(active ? { id: active.vehicle_location_id, label: active.vehicle_name } : null);
    } else {
      setActiveCheckout(null); setVehicle(null);
    }
  }, [visible, locationId, initialKind, user?.id]);

  const dirty =
    type.trim().length > 0 || notes.trim().length > 0 ||
    odometer.trim().length > 0 || cost.trim().length > 0 ||
    gallons.trim().length > 0 || kind !== initialKind || target !== 'vehicle' ||
    forPick != null;

  function reject(field: string, rule: string) {
    track('audit', 'validation_reject', { screen: 'vehicle_service', props: { field, rule } });
  }

  // #173: quick-add a job straight from the "For" picker (gas receipt), same
  // pattern as JobQuickAdd — local write + activity log, then select it.
  function createJob(text: string) {
    if (!user) return;
    if (isWriteBlocked()) return;
    const now = new Date().toISOString();
    const newJob: Job = {
      id: generateUUID(), name: text, status: 'open',
      created_by: user.id, created_at: now, updated_at: now, synced_at: null,
    };
    runInTransaction(() => {
      upsertJob(newJob);
      appendLog({
        action: 'job_created', entity_type: 'job', entity_id: newJob.id,
        user_id: (realUser ?? user).id, team_id: null, from_location_id: null, to_location_id: null,
        quantity: null, unit: null, job_id: newJob.id, note: newJob.name,
        metadata: null, device_id: null,
      });
    });
    setForPick({ id: newJob.id, label: newJob.name, sublabel: 'Job' });
  }

  async function submit() {
    if (isWriteBlocked()) return;
    if (!vehicle) { reject('vehicle_service.vehicle', 'required'); Alert.alert('Required', 'Pick a vehicle.'); return; }
    if (!isFuelUp && !type.trim()) {
      reject('vehicle_service.type', 'required');
      Alert.alert('Required', 'Enter a service type.');
      return;
    }
    // #168: every fuel-up is charged to someone — For (team or job) is REQUIRED.
    if (isFuelUp && !forPick) {
      reject('vehicle_service.payer', 'required');
      Alert.alert('Required', "Pick who it's for — a team, a job, or a payer like Office.");
      return;
    }
    const typeResult = validateText(isFuelUp ? FUEL_UP_TYPE : type, { label: 'Service type', max: 100 });
    if (!typeResult.ok) { reject('vehicle_service.type', typeResult.rule); Alert.alert('Invalid service type', typeResult.error); return; }
    let gallonsValue: number | null = null;
    if (isFuelUp) {
      const gallonsResult = parseOptionalNonNegative(gallons, 'Gallons');
      if (!gallonsResult.ok) { reject('vehicle_service.gallons', gallonsResult.rule); Alert.alert('Invalid gallons', gallonsResult.error); return; }
      gallonsValue = gallonsResult.value;
    }
    const notesResult = validateText(notes, { label: 'Notes' });
    if (!notesResult.ok) { reject('vehicle_service.notes', notesResult.rule); Alert.alert('Invalid notes', notesResult.error); return; }
    const dateResult = parseOptionalDate(date, 'Date');
    if (!dateResult.ok) { reject('vehicle_service.event_date', dateResult.rule); Alert.alert('Invalid date', dateResult.error); return; }
    const odoResult = parseOptionalCount(odometer, 'Odometer');
    if (!odoResult.ok) { reject('vehicle_service.odometer', odoResult.rule); Alert.alert('Invalid odometer', odoResult.error); return; }
    // Cost is only offered to financial users; blank → null (0 is a real cost —
    // warranty work — distinct from unset, so it stays a plain text field).
    let costValue: number | null = null;
    if (canViewFinancial) {
      const costResult = parseOptionalNonNegative(cost, 'Cost');
      if (!costResult.ok) { reject('vehicle_service.cost', costResult.rule); Alert.alert('Invalid cost', costResult.error); return; }
      costValue = costResult.value;
    }

    // #168: picking a different vehicle than the active checkout is allowed but logged.
    const mismatch = isFuelUp && activeCheckout != null && activeCheckout.id !== vehicle.id;
    const logNote = mismatch
      ? buildReceiptVehicleMismatchNote(activeCheckout!.name, vehicle.label)
      : null;

    setBusy(true);
    try {
      runInTransaction(() => {
        const { id, note } = createServiceRecord({
          vehicleLocationId: vehicle.id,
          target: isFuelUp ? 'vehicle' : target,
          eventDate: dateResult.value ?? new Date().toISOString(),
          type: typeResult.value,
          notes: isFuelUp ? buildFuelUpNotes(gallonsValue, notesResult.value) : (notesResult.value || null),
          odometer: odoResult.value,
          cost: costValue,
          // payer is a TEXT snapshot of the chosen team/job name; job receipts
          // additionally carry the durable job_id.
          payer: isFuelUp ? forPick?.label ?? null : null,
          jobId: isFuelUp && forPick && jobIds.has(forPick.id) ? forPick.id : null,
          logNote,
          userId: user?.id ?? null,
        });
        appendLog({
          action: 'vehicle_service_logged',
          entity_type: 'location',
          entity_id: vehicle.id,
          user_id: user?.id ?? null,
          team_id: null,
          job_id: null,
          note,
          from_location_id: null,
          to_location_id: null,
          quantity: null,
          unit: null,
          metadata: null,
          device_id: null,
        });
        void id;
      });
      onSaved?.();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title="Log Service"
      dirty={dirty}
      busy={busy}
      onSubmit={() => { void submit(); }}
    >
      <View style={s.fields}>
        {/* Non-editors are receipt-only: no Entry segment, kind is fuel_up. */}
        {isEditor && (
          <View>
            <FieldLabel>Entry</FieldLabel>
            <SegmentedControl
              segments={KIND_SEGMENTS}
              value={kind}
              onChange={id => setKind(id as 'service' | 'fuel_up')}
              size="sm"
            />
          </View>
        )}
        {/* #168: QuickAdd entry has no fixed vehicle — pick one (defaults to
            the active checkout; changing it is allowed but noted). */}
        {!locationId && (
          <View>
            <FieldLabel>Vehicle *</FieldLabel>
            <SearchablePicker
              placeholder="Search vehicles..."
              options={vehicleOptions}
              value={vehicle}
              onSelect={opt => setVehicle(prev => (prev?.id === opt.id ? null : opt))}
            />
            {isFuelUp && activeCheckout && vehicle && activeCheckout.id !== vehicle.id && (
              <Text style={s.mismatch}>You have {activeCheckout.name} checked out — this will be noted.</Text>
            )}
          </View>
        )}
        {!isFuelUp && (
          <View>
            <FieldLabel>Serviced *</FieldLabel>
            <SegmentedControl
              segments={TARGET_SEGMENTS}
              value={target}
              onChange={id => setTarget(id as ServiceTarget)}
              size="sm"
            />
          </View>
        )}
        {!isFuelUp ? (
          <TextField
            label="Type"
            required
            value={type}
            onChangeText={setType}
            placeholder="Oil change, tires, filter swap…"
          />
        ) : (
          <>
            {/* #168: "For" is ONE dynamic type-ahead over payers + teams +
                open jobs (sublabel says which). */}
            <View>
              <FieldLabel>For *</FieldLabel>
              <SearchablePicker
                placeholder="Type a team, job, or Office..."
                options={forOptions}
                value={forPick}
                onSelect={opt => setForPick(prev => (prev?.id === opt.id ? null : opt))}
                onCreate={canCreateJobs ? createJob : undefined}
              />
            </View>
            <TextField
              label="Gallons (optional)"
              value={gallons}
              onChangeText={setGallons}
              placeholder="e.g. 12.5"
              keyboardType="numeric"
            />
          </>
        )}
        <DateField label="Date" value={date} onChange={setDate} />
        <TextField
          label="Odometer (optional)"
          value={odometer}
          onChangeText={setOdometer}
          placeholder="e.g. 84200"
          keyboardType="numeric"
        />
        {canViewFinancial && (
          <TextField
            label="Cost (optional)"
            value={cost}
            onChangeText={setCost}
            placeholder="0.00"
            keyboardType="numeric"
          />
        )}
        <TextField
          label="Notes (optional)"
          value={notes}
          onChangeText={setNotes}
          placeholder="Notes"
          multiline
        />
      </View>
    </FormSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  fields: { gap: t.spacing.md, paddingBottom: t.spacing.sm },
  mismatch: { fontSize: t.typography.fontSizes.xs, color: t.colors.warningText, marginTop: t.spacing.xs },
});
