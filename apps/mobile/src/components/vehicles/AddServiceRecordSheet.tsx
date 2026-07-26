import { useEffect, useMemo, useState } from 'react';
import { View, Text, Image, Pressable, StyleSheet, Modal, TouchableOpacity, ActivityIndicator } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from '../../lib/themedAlert';
import { FormSheet } from '../ui/FormSheet';
import { SegmentedControl } from '../ui/SegmentedControl';
import { TextField } from '../ui/TextField';
import { DateField } from '../ui/DateField';
import { FieldLabel } from '../ui/FieldLabel';
import { confirmSheet } from '../ui/ConfirmSheet';
import { SearchablePicker, type PickerOption } from '../SearchablePicker';
import { createServiceRecord, getActiveCheckoutForUser, type ServiceTarget } from '../../db/queries/vehicles';
import { getUnitLocations, getLocationById } from '../../db/queries/locations';
import { getOpenJobs } from '../../db/queries/jobs';
import { getAllTeams } from '../../db/queries/teams';
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
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';

// FormSheet FIRST ADOPTER (#125): battle-tests the dirty-state discard guard +
// busy/submit plumbing inside the ModalSheet stack. Field set mirrors the
// equipment Log Maintenance modal, plus the vehicle-specific `target` segment
// (which part was serviced) and an optional odometer reading.
//
// #168 grew the Fuel-up branch into the gas receipt (user decision: ONE form,
// not a parallel sheet): photo (nudged-optional) and a REQUIRED "For" that
// follows the CHECKOUT taxonomy (user review #2): Team (real teams from the
// DB) or Job (open jobs) — not a parallel app_config payer list. payer stores
// the chosen name as a TEXT snapshot; job receipts also set job_id.
// Non-editors are locked to the Fuel-up kind — any crew member files a
// receipt; service records stay edit_inventory-only. Without `locationId`
// (QuickAdd entry) a vehicle picker appears, defaulting to the caller's
// active checkout; picking a different vehicle is allowed but logged
// (buildReceiptVehicleMismatchNote).
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
  const t = useTheme();
  const { user } = useSession();
  const canViewFinancial = usePermission('view_financial_data');
  // #168: non-editors may only file fuel-ups/receipts (crew-level write);
  // arbitrary service records remain an editor action.
  const isEditor = usePermission('edit_inventory');

  const [kind, setKind] = useState<'service' | 'fuel_up'>(initialKind);
  const [target, setTarget] = useState<ServiceTarget>('vehicle');
  const [type, setType] = useState('');
  const [date, setDate] = useState(today);
  const [odometer, setOdometer] = useState('');
  const [gallons, setGallons] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  // #168 "For" — ONE dynamic search over teams + jobs (user review #3: a
  // single type-ahead like the rest of the app, no toggle).
  const [forPick, setForPick] = useState<PickerOption | null>(null);
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
  // "For" options: teams and open jobs in ONE ranked search, sublabel telling
  // them apart. jobIds resolves the picked kind at submit time.
  const { forOptions, jobIds } = useMemo(() => {
    if (!visible) return { forOptions: [] as PickerOption[], jobIds: new Set<string>() };
    const teams = getAllTeams().map(tm => ({ id: tm.id, label: tm.name, sublabel: 'Team' }));
    const jobs = getOpenJobs().map(j => ({ id: j.id, label: j.name, sublabel: 'Job' }));
    return { forOptions: [...teams, ...jobs], jobIds: new Set(jobs.map(j => j.id)) };
  }, [visible]);

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
    photo != null || forPick != null;

  function reject(field: string, rule: string) {
    track('audit', 'validation_reject', { screen: 'vehicle_service', props: { field, rule } });
  }

  async function pickPhoto(fromCamera: boolean) {
    setSourceOpen(false);
    if (fromCamera) {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission Required', 'Allow camera access to take photos.');
        return;
      }
    }
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
    // #168: every fuel-up is charged to someone — For (team or job) is REQUIRED.
    if (isFuelUp && !forPick) {
      reject('vehicle_service.payer', 'required');
      Alert.alert('Required', "Pick who it's for — a team or a job.");
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
        // payer is a TEXT snapshot of the chosen team/job name; job receipts
        // additionally carry the durable job_id.
        payer: isFuelUp ? forPick?.label ?? null : null,
        jobId: isFuelUp && forPick && jobIds.has(forPick.id) ? forPick.id : null,
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
            {/* #168: the receipt half of a fuel-up — photo, payer, job.
                Photo affordance = MediaGallery's thumb-variant dashed box +
                source sheet (the house pattern), not ad-hoc buttons. */}
            <View>
              <FieldLabel>Receipt photo</FieldLabel>
              <View style={s.photoRow}>
                <TouchableOpacity
                  style={s.thumbBox}
                  activeOpacity={0.8}
                  disabled={busy}
                  onPress={() => setSourceOpen(true)}
                >
                  {busy ? (
                    <ActivityIndicator color={t.colors.primary} />
                  ) : photo ? (
                    <Image source={{ uri: photo.uri }} style={s.thumbBoxImg} />
                  ) : (
                    <>
                      <Text style={s.thumbBoxIcon}>＋</Text>
                      <Text style={s.thumbBoxText}>Photo</Text>
                    </>
                  )}
                </TouchableOpacity>
                {photo && (
                  <Pressable onPress={() => setPhoto(null)} hitSlop={8}>
                    <Text style={s.remove}>Remove</Text>
                  </Pressable>
                )}
              </View>
            </View>
            {/* #168: "For" is ONE dynamic type-ahead over teams + open jobs
                (sublabel says which) — same search idiom as the rest of the
                app; the checkout taxonomy without a mode toggle. */}
            <View>
              <FieldLabel>For *</FieldLabel>
              <SearchablePicker
                placeholder="Type a team or job..."
                options={forOptions}
                value={forPick}
                onSelect={opt => setForPick(opt)}
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

      {/* Photo source picker — MediaGallery's sheet pattern, trimmed to images. */}
      <Modal visible={sourceOpen} transparent animationType="slide" onRequestClose={() => setSourceOpen(false)}>
        <TouchableOpacity style={s.sheetOverlay} activeOpacity={1} onPress={() => setSourceOpen(false)}>
          <View style={s.sourceSheet}>
            <View style={s.sheetHandle} />
            <Text style={s.sheetTitle}>Add receipt photo</Text>
            <View style={s.sourceRow}>
              <TouchableOpacity style={s.sourceCard} onPress={() => { void pickPhoto(true); }} activeOpacity={0.85}>
                <View style={[s.sourceIconWrap, { backgroundColor: t.colors.primaryBg }]}>
                  <Text style={s.sourceIcon}>📷</Text>
                </View>
                <Text style={s.sourceLabel}>Take photo</Text>
                <Text style={s.sourceSub}>Use the camera</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.sourceCard} onPress={() => { void pickPhoto(false); }} activeOpacity={0.85}>
                <View style={[s.sourceIconWrap, { backgroundColor: t.colors.accentBg }]}>
                  <Text style={s.sourceIcon}>🖼️</Text>
                </View>
                <Text style={s.sourceLabel}>Choose</Text>
                <Text style={s.sourceSub}>From the library</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity style={s.sheetCancel} onPress={() => setSourceOpen(false)}>
              <Text style={s.sheetCancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </FormSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  fields: { gap: t.spacing.md, paddingBottom: t.spacing.sm },
  photoRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.md },
  remove: { color: t.colors.danger, fontWeight: '600', fontSize: t.typography.fontSizes.sm },
  mismatch: { fontSize: t.typography.fontSizes.xs, color: t.colors.warningText, marginTop: t.spacing.xs },
  // Photo attach — MediaGallery's thumb-variant dashed box (the house element).
  thumbBox: {
    width: 64, height: 64, borderRadius: 10,
    borderWidth: 2, borderColor: t.colors.border, borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
    backgroundColor: t.colors.background,
  },
  thumbBoxImg: { width: '100%', height: '100%', borderRadius: 8 },
  thumbBoxIcon: { fontSize: 22, color: t.colors.primary, fontWeight: '300', lineHeight: 24 },
  thumbBoxText: { fontSize: 10, color: t.colors.textSecondary, fontWeight: '600' },
  // Source picker — MediaGallery's sheet styles verbatim (keep in sync).
  sheetOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' },
  sourceSheet: {
    backgroundColor: t.colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 20, paddingTop: 10, paddingBottom: 34, gap: 16,
  },
  sheetHandle: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: t.colors.border, marginBottom: 4 },
  sheetTitle: { fontSize: 17, fontWeight: '800', color: t.colors.textPrimary, textAlign: 'center' },
  sourceRow: { flexDirection: 'row', gap: 12 },
  sourceCard: {
    flex: 1, alignItems: 'center', gap: 6, paddingVertical: 18,
    borderRadius: 16, borderWidth: 1, borderColor: t.colors.border, backgroundColor: t.colors.background,
  },
  sourceIconWrap: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  sourceIcon: { fontSize: 26 },
  sourceLabel: { fontSize: 15, fontWeight: '700', color: t.colors.textPrimary },
  sourceSub: { fontSize: 12, color: t.colors.textMuted },
  sheetCancel: { alignItems: 'center', paddingVertical: 12, borderRadius: 12, backgroundColor: t.colors.background },
  sheetCancelText: { fontSize: 15, fontWeight: '700', color: t.colors.textSecondary },
});
