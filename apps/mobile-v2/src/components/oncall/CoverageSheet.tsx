import { useEffect, useState } from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import type { Theme } from '@invenpro/ui';
import {
  useThemedStyles, Alert, FormSheet, TextField, DateRangeField, SelectField,
  type SelectOption, confirmSheet,
} from '@invenpro/ui';
import { useDbQuery, runInTransaction } from '@invenpro/core';
import { getAllActiveUsers } from '../../repos/users';
import { createCoverage, updateCoverage, deleteCoverage, type CoverageRow } from '../../repos/oncall';
import { useSession } from '../../hooks/useSession';
import { isWriteBlocked } from '../../db/maintenance';
import { appendLog } from '../../db/queries/log';
import { localTodayIso } from './weekMath';

// Station C2: ported from apps/mobile/src/components/oncall/CoverageSheet.tsx
// (create-only there), EXTENDED for edit mode — the mechanical
// list+detail+create/edit definition of done for on_call_coverage needs an
// edit surface the old app never had. Passing `coverage` opens the sheet
// pre-filled against that row (detail/edit); omitting it (or null) is the
// original create flow. A "Delete coverage" action appears only in edit mode.
//
// Import mapping: '../../lib/themedAlert' + ui/* -> '@invenpro/ui',
// '../../db/queries/users' -> '../../repos/users', '../../db/queries/oncall'
// -> '../../repos/oncall', '../../db/tx' -> '@invenpro/core',
// './OnCallCalendar' (re-exported localTodayIso) -> './weekMath' directly
// (its actual home — see weekMath.ts's header comment).
//
// Behavior change (no-self-log convention): createCoverage() no longer logs
// 'on_call_coverage_added' itself — this sheet now builds that entry, wrapped
// in the SAME runInTransaction the repo call already opens (reentrant -> one
// commit). updateCoverage/deleteCoverage are deliberately NOT logged (see
// oncall.ts's header comments on both — no allowlisted server action exists
// for coverage edits/deletes; the row itself still syncs).
interface Props {
  visible: boolean;
  onClose: () => void;
  /** Present -> edit/detail an existing row; absent/null -> create. */
  coverage?: CoverageRow | null;
}

export function CoverageSheet({ visible, onClose, coverage = null }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const editing = !!coverage;

  const [dateStart, setDateStart] = useState('');
  const [dateEnd, setDateEnd] = useState('');
  const [userOff, setUserOff] = useState<string | null>(null);
  const [coveringUser, setCoveringUser] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // Fresh form on every open (the sheet component itself stays mounted while
  // hidden, so state would otherwise leak between opens) — pre-filled from
  // `coverage` in edit mode.
  useEffect(() => {
    if (!visible) return;
    setDateStart(coverage?.date_start ?? '');
    setDateEnd(coverage?.date_end ?? '');
    setUserOff(coverage?.user_off ?? null);
    setCoveringUser(coverage?.covering_user ?? null);
    setNote(coverage?.note ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, coverage?.id]);

  // Re-runs whenever a local write OR a background sync pull touches users
  // (#60/#63) — no manual reload key needed.
  const users = useDbQuery<SelectOption[]>(
    () => getAllActiveUsers().map(u => ({ id: u.id, label: u.name })),
    [],
    ['users'],
  );

  const dirty = editing
    ? dateStart !== coverage!.date_start || dateEnd !== coverage!.date_end ||
      userOff !== coverage!.user_off || coveringUser !== coverage!.covering_user ||
      note !== (coverage!.note ?? '')
    : dateStart.length > 0 || dateEnd.length > 0 ||
      userOff !== null || coveringUser !== null || note.trim().length > 0;

  function validate(): boolean {
    if (!dateStart || !dateEnd || !userOff || !coveringUser) {
      Alert.alert('Required', 'Fill in the dates and both people.');
      return false;
    }
    if (dateEnd < dateStart) {
      Alert.alert('Invalid range', 'Last day must be on or after the first day.');
      return false;
    }
    if (userOff === coveringUser) {
      Alert.alert('Invalid coverage', 'The covering person must be different from the person off.');
      return false;
    }
    return true;
  }

  function submit() {
    if (isWriteBlocked()) return;
    if (!validate()) return;

    setBusy(true);
    try {
      if (editing) {
        updateCoverage({
          id: coverage!.id, dateStart, dateEnd, userOff: userOff!, coveringUser: coveringUser!,
          note: note.trim() || null,
        });
      } else {
        runInTransaction(() => {
          const result = createCoverage({
            dateStart, dateEnd, userOff: userOff!, coveringUser: coveringUser!,
            note: note.trim() || null, createdBy: user?.id ?? null,
          });
          appendLog({
            user_id: user?.id ?? null, team_id: null, action: 'on_call_coverage_added', entity_type: 'team',
            entity_id: null, from_location_id: null, to_location_id: null, quantity: null, unit: null,
            job_id: null, note: `${result.coveringUserName} covering for ${result.userOffName}`,
            metadata: JSON.stringify({ coverage_id: result.id, user_off: userOff, covering_user: coveringUser }),
            device_id: null,
          });
        });
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!coverage) return;
    const ok = await confirmSheet({
      title: 'Delete this coverage entry?',
      message: 'This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      deleteCoverage(coverage.id);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormSheet
      visible={visible}
      onClose={onClose}
      title={editing ? 'Edit Coverage' : 'Add Coverage'}
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
          min={editing ? undefined : localTodayIso()}
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
        {editing && (
          <TouchableOpacity onPress={handleDelete} disabled={busy} style={s.deleteRow}>
            <Text style={s.deleteText}>Delete coverage</Text>
          </TouchableOpacity>
        )}
      </View>
    </FormSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  fields: { gap: t.spacing.md, paddingBottom: t.spacing.sm },
  deleteRow: { marginTop: t.spacing.sm, alignItems: 'center' },
  deleteText: { fontSize: t.typography.fontSizes.body, color: t.colors.danger, fontWeight: '600' },
});
