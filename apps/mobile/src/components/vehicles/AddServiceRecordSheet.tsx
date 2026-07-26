import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { View, Text, Image, Pressable, StyleSheet } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from '../../lib/themedAlert';
import { FormSheet } from '../ui/FormSheet';
import { SegmentedControl } from '../ui/SegmentedControl';
import { TextField } from '../ui/TextField';
import { DateField } from '../ui/DateField';
import { FieldLabel } from '../ui/FieldLabel';
import { StatusPill } from '../ui/StatusPill';
import { PrimaryButton } from '../ui/PrimaryButton';
import { confirmSheet } from '../ui/ConfirmSheet';
import { SearchablePicker, type PickerOption } from '../SearchablePicker';
import { createServiceRecord, getActiveCheckoutForUser, type ServiceTarget } from '../../db/queries/vehicles';
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

// FormSheet FIRST ADOPTER (#125): battle-tests the dirty-state discard guard +
// busy/submit plumbing inside the ModalSheet stack. Field set mirrors the
// equipment Log Maintenance modal, plus the vehicle-specific `target` segment
// (which part was serviced) and an optional odometer reading.
//
// #168 grew the Fuel-up branch into the gas receipt (user decision: ONE form,
// not a parallel sheet): photo (nudged-optional), payer (REQUIRED, live list
// from app_config), optional job. Non-editors are locked to the Fuel-up kind —
// any crew member files a receipt; service records stay edit_inventory-only.
// Without `locationId` (QuickAdd entry) a vehicle picker appears, defaulting
// to the caller's active checkout; picking a different vehicle is allowed but
// logged (buildReceiptVehicleMismatchNote).
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

interface PickedPhoto {
  uri: string;
  ext: string; // lowercase, no dot
  size?: number; // bytes when the picker reports it
}

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
  const { user } = useSession();
  const canViewFinancial = usePermission('view_financial_data');
  // #168: non-editors may only file fuel-ups/receipts (crew-level write);
  // arbitrary service records remain an editor action.
  const isEditor = usePermission('edit_inventory');

  // Live payer list — settings edits show without remount (hiddenFields pattern).
  const payersVersion = useSyncExternalStore(subscribeGasReceiptPayers, getGasReceiptPayersVersion, getGasReceiptPayersVersion);
  const payers = useMemo(() => getGasReceiptPayers(), [payersVersion]);

  const [kind, setKind] = useState<'service' | 'fuel_up'>(initialKind);
  const [target, setTarget] = useState<ServiceTarget>('vehicle');
  const [type, setType] = useState('');
  const [date, setDate] = useState(today);
  const [odometer, setOdometer] = useState('');
  const [gallons, setGallons] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [payer, setPayer] = useState<string | null>(null);
  const [job, setJob] = useState<PickerOption | null>(null);
  const [vehicle, setVehicle] = useState<PickerOption | null>(null);
  const [busy, setBusy] = useState(false);

  // The active checkout at open time — the default vehicle AND the mismatch baseline.
  const [activeCheckout, setActiveCheckout] = useState<{ id: string; name: string } | null>(null);

  const effectiveKind = isEditor ? kind : 'fuel_up';
  const isFuelUp = effectiveKind === 'fuel_up';

  const vehicleOptions = useMemo<PickerOption[]>(
    () => (locationId || !visible ? [] : getUnitLocations('Vehicle').map(l => ({ id: l.id, label: l.name }))),
    [visible, locationId],
  );
  const jobOptions = useMemo<PickerOption[]>(
    () => (visible ? getOpenJobs().map(j => ({ id: j.id, label: j.name })) : []),
    [visible],
  );

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
    setPhoto(null);
    setPayer(null);
    setJob(null);
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
    photo != null || payer != null || job != null;

  function reject(field: string, rule: string) {
    track('audit', 'validation_reject', { screen: 'vehicle_service', props: { field, rule } });
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
    if (!vehicle) { reject('vehicle_service.vehicle', 'required'); Alert.alert('Required', 'Pick a vehicle.'); return; }
    if (!isFuelUp && !type.trim()) {
      reject('vehicle_service.type', 'required');
      Alert.alert('Required', 'Enter a service type.');
      return;
    }
    // #168: every fuel-up is charged to someone — payer is REQUIRED.
    if (isFuelUp && !payer) {
      reject('vehicle_service.payer', 'required');
      Alert.alert('Required', "Pick who it's for.");
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
    // #168: nudged-optional photo on fuel-ups — one confirm, never a block.
    if (isFuelUp && !photo) {
      const ok = await confirmSheet({
        title: 'No receipt photo attached — save anyway?',
        message: 'The office reimburses against the photo. You can still save without one.',
        confirmLabel: 'Save Anyway',
      });
      if (!ok) return;
    }

    // #168: picking a different vehicle than the active checkout is allowed but logged.
    const mismatch = isFuelUp && activeCheckout != null && activeCheckout.id !== vehicle.id;
    const logNote = mismatch
      ? buildReceiptVehicleMismatchNote(activeCheckout!.name, vehicle.label)
      : null;

    setBusy(true);
    try {
      const recordId = createServiceRecord({
        vehicleLocationId: vehicle.id,
        target: isFuelUp ? 'vehicle' : target,
        eventDate: dateResult.value ?? new Date().toISOString(),
        type: typeResult.value,
        notes: isFuelUp ? buildFuelUpNotes(gallonsValue, notesResult.value) : (notesResult.value || null),
        odometer: odoResult.value,
        cost: costValue,
        payer: isFuelUp ? payer : null,
        jobId: isFuelUp ? job?.id ?? null : null,
        logNote,
        userId: user?.id ?? null,
      });
      // Record is committed — the upload can fail without losing anything.
      if (isFuelUp && photo && user?.id) {
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
              onSelect={opt => setVehicle(opt)}
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
            {/* #168: the receipt half of a fuel-up — photo, payer, job. */}
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
                  <PrimaryButton label="🖼 Library" onPress={() => { void pickPhoto(false); }} />
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
            <TextField
              label="Gallons (optional)"
              value={gallons}
              onChangeText={setGallons}
              placeholder="e.g. 12.5"
              keyboardType="numeric"
            />
            <View>
              <FieldLabel>Job (optional)</FieldLabel>
              <SearchablePicker
                placeholder="Search open jobs..."
                options={jobOptions}
                value={job}
                onSelect={opt => setJob(prev => prev?.id === opt.id ? null : opt)}
              />
            </View>
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
  photoButtons: { flexDirection: 'row', gap: t.spacing.md },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  thumb: { width: 72, height: 72, borderRadius: t.radii.md, backgroundColor: t.colors.surfaceAlt },
  remove: { color: t.colors.danger, fontWeight: '600', fontSize: t.typography.fontSizes.sm },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm },
  mismatch: { fontSize: t.typography.fontSizes.xs, color: t.colors.warningText, marginTop: t.spacing.xs },
});
