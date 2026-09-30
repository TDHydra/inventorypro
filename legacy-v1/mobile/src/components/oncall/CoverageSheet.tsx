import { useEffect, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import { FormSheet } from '../ui/FormSheet';
import { TextField } from '../ui/TextField';
import { DateRangeField } from '../ui/DateRangeField';
import { SelectField, type SelectOption } from '../ui/SelectField';
import { getAllActiveUsers } from '../../db/queries/users';
import { createCoverage } from '../../db/queries/oncall';
import { useSession } from '../../hooks/useSession';
import { isWriteBlocked } from '../../db/maintenance';
import { useDbQuery } from '../../hooks/useDbQuery';
import { localTodayIso } from './OnCallCalendar';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

// PM-authored coverage/time-off entry (#122 Phase C): "X covers Y from A to B".
// Mirrors AddServiceRecordSheet (the FormSheet host pattern): state reset on
// open, dirty calc for the discard guard, validation → Alert. The PM gate
// lives at the call site (OnCallWidget); server enforces manage_teams.
interface Props {
  visible: boolean;
  onClose: () => void;
}

export function CoverageSheet({ visible, onClose }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();

  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [userOff, setUserOff] = useState<string | null>(null);
  const [coveringUser, setCoveringUser] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Fresh form on every open (the sheet component itself stays mounted while
  // hidden, so state would otherwise leak between opens).
  useEffect(() => {
    if (visible) {
      setDateStart('');
      setDateEnd('');
      setUserOff(null);
      setCoveringUser(null);
      setNote('');
    }
  }, [visible]);

  // Re-runs whenever a local write OR a background sync pull touches users
  // (#60/#63) — no manual reload key needed.
  const users = useDbQuery<SelectOption[]>(
    () => getAllActiveUsers().map(u => ({ id: u.id, label: u.name })),
    [],
    ['users'],
  );

  const dirty =
    dateStart.length > 0 || dateEnd.length > 0 ||
    userOff !== null || coveringUser !== null || note.trim().length > 0;

  function submit() {
    if (isWriteBlocked()) return;
    if (!dateStart || !dateEnd || !userOff || !coveringUser) {
      Alert.alert('Required', 'Fill in the dates and both people.');
      return;
    }
    if (dateEnd < dateStart) {
      Alert.alert('Invalid range', 'Last day must be on or after the first day.');
      return;
    }
    if (userOff === coveringUser) {
      Alert.alert('Invalid coverage', 'The covering person must be different from the person off.');
      return;
    }

    setBusy(true);
    try {
      createCoverage({
        dateStart,
        dateEnd,
        userOff,
        coveringUser,
        note: note.trim() || null,
        createdBy: user?.id ?? null,
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
      title="Add Coverage"
      dirty={dirty}
      busy={busy}
      onSubmit={submit}
    >
      <View style={s.fields}>
        <DateRangeField
          label="Days off"
          start={dateStart}
          end={dateEnd}
          onChange={(start, end) => {
            setDateStart(start);
            setDateEnd(end);
          }}
          min={localTodayIso()}
          required
          hint="First day → last day (inclusive)"
        />

        <SelectField
          label="Who is off"
          required
          value={userOff}
          options={users}
          onSelect={setUserOff}
        />
        <SelectField
          label="Covering person"
          required
          value={coveringUser}
          options={users}
          onSelect={setCoveringUser}
        />
        <TextField
          label="Note (optional)"
          value={note}
          onChangeText={setNote}
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
