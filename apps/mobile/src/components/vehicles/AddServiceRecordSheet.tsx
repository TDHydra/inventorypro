import { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import { FormSheet } from '../ui/FormSheet';
import { SegmentedControl } from '../ui/SegmentedControl';
import { TextField } from '../ui/TextField';
import { DateField } from '../ui/DateField';
import { FieldLabel } from '../ui/FieldLabel';
import { createServiceRecord, type ServiceTarget } from '../../db/queries/vehicles';
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
const TARGET_SEGMENTS = [
  { id: 'vehicle', label: 'Vehicle' },
  { id: 'truck_mount', label: 'Truck mount' },
  { id: 'both', label: 'Both' },
];

const today = () => new Date().toISOString().slice(0, 10);

interface Props {
  locationId: string;
  visible: boolean;
  onClose: () => void;
}

export function AddServiceRecordSheet({ locationId, visible, onClose }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const canViewFinancial = usePermission('view_financial_data');

  const [target, setTarget] = useState<ServiceTarget>('vehicle');
  const [type, setType] = useState('');
  const [date, setDate] = useState(today);
  const [odometer, setOdometer] = useState('');
  const [cost, setCost] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  // Fresh form on every open (the sheet component itself stays mounted while
  // hidden, so state would otherwise leak between opens).
  useEffect(() => {
    if (visible) {
      setTarget('vehicle');
      setType('');
      setDate(today());
      setOdometer('');
      setCost('');
      setNotes('');
    }
  }, [visible]);

  const dirty =
    type.trim().length > 0 || notes.trim().length > 0 ||
    odometer.trim().length > 0 || cost.trim().length > 0 || target !== 'vehicle';

  function reject(field: string, rule: string) {
    track('audit', 'validation_reject', { screen: 'vehicle_service', props: { field, rule } });
  }

  function submit() {
    if (isWriteBlocked()) return;
    if (!type.trim()) {
      reject('vehicle_service.type', 'required');
      Alert.alert('Required', 'Enter a service type.');
      return;
    }
    const typeResult = validateText(type, { label: 'Service type', max: 100 });
    if (!typeResult.ok) { reject('vehicle_service.type', typeResult.rule); Alert.alert('Invalid service type', typeResult.error); return; }
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

    setBusy(true);
    try {
      createServiceRecord({
        vehicleLocationId: locationId,
        target,
        eventDate: dateResult.value ?? new Date().toISOString(),
        type: typeResult.value,
        notes: notesResult.value || null,
        odometer: odoResult.value,
        cost: costValue,
        userId: user?.id ?? null,
      });
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
      onSubmit={submit}
    >
      <View style={s.fields}>
        <View>
          <FieldLabel>Serviced *</FieldLabel>
          <SegmentedControl
            segments={TARGET_SEGMENTS}
            value={target}
            onChange={id => setTarget(id as ServiceTarget)}
            size="sm"
          />
        </View>
        <TextField
          label="Type"
          required
          value={type}
          onChangeText={setType}
          placeholder="Oil change, tires, filter swap…"
        />
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
});
