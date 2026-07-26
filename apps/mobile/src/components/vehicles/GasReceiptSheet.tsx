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
import { createServiceRecord, getActiveCheckoutForUser } from '../../db/queries/vehicles';
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
  ext: string; // lowercase, no dot
  size?: number; // bytes when the picker reports it
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Vehicle-page entry: vehicle fixed to this location, no picker. */
  lockedVehicleId?: string;
  /** Fired after a successful save, before onClose (QuickAdd shell toast). */
  onSaved?: () => void;
}

/**
 * #168 gas receipt: a fuel_up service record (payer REQUIRED, photo nudged-
 * optional) + optional service_record media. Vehicle defaults to the caller's
 * active checkout; picking a different one is allowed but logged
 * (buildReceiptVehicleMismatchNote). The record commits offline-first; the
 * photo upload is online-only — failure never rolls back the record.
 */
export function GasReceiptSheet({ visible, onClose, lockedVehicleId, onSaved }: Props) {
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
    () => (lockedVehicleId || !visible ? [] : getUnitLocations('Vehicle').map(l => ({ id: l.id, label: l.name }))),
    [visible, lockedVehicleId],
  );
  const jobOptions = useMemo<PickerOption[]>(
    () => (visible ? getOpenJobs().map(j => ({ id: j.id, label: j.name })) : []),
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
