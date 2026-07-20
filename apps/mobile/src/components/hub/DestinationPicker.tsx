import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SearchablePicker, type PickerOption } from '../SearchablePicker';
import { LocationShelfPicker } from '../pickers/LocationShelfPicker';
import { getOpenJobs, upsertJob, type Job } from '../../db/queries/jobs';
import { getManagerTierUsers } from '../../db/queries/users';
import {
  getOfficeLocations, getLocationsByOwner, getLocationById,
  resolveLocationShelfSelection, type Location,
} from '../../db/queries/locations';
import { getUnitInventoryLock } from '../../db/queries/access';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { generateUUID } from '../../utils/uuid';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { useTableVersion } from '../../hooks/useDataVersion';
import { isWriteBlocked } from '../../db/maintenance';
import { runInTransaction } from '../../db/tx';
import { Alert } from '../../lib/themedAlert';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

export interface ResolvedDestination {
  type: 'location' | 'job' | 'manager' | 'office';
  label: string;            // human label for the receipt
  toLocationId: string | null; // credited location (null for job)
  jobId: string | null;        // set for job
}

type DestType = 'location' | 'job' | 'manager' | 'office';

interface Props {
  onResolved: (d: ResolvedDestination | null) => void;
}

// Pick where a scanned consumable/equipment goes: Location, Job, Manager (→ their
// owned location), or Office. Mirrors checkout's split-button destination row.
export function DestinationPicker({ onResolved }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const canCreateJobs = usePermission('create_jobs');

  const [destType, setDestType] = useState<DestType | null>(null);
  const [locationValue, setLocationValue] = useState<PickerOption | null>(null);
  // Optional shelf within a has_shelves location — the dynamic sub-field of
  // LocationShelfPicker. Held here so the caller can resolve it at commit.
  const [shelfValue, setShelfValue] = useState<PickerOption | null>(null);
  const [jobValue, setJobValue] = useState<PickerOption | null>(null);
  const [managerValue, setManagerValue] = useState<PickerOption | null>(null);
  const [managerLocs, setManagerLocs] = useState<Location[]>([]);
  const [managerLocValue, setManagerLocValue] = useState<PickerOption | null>(null);
  const [officeValue, setOfficeValue] = useState<PickerOption | null>(null);

  // Options re-read when a job/user/location changes (synced or created
  // elsewhere in the flow, e.g. createJob below).
  const version = useTableVersion(['jobs', 'users', 'locations']);

  const jobOptions: PickerOption[] = useMemo(
    () => getOpenJobs().map(j => ({ id: j.id, label: j.name })),
    [version],
  );
  const managerOptions: PickerOption[] = useMemo(
    () => getManagerTierUsers().map(u => ({ id: u.id, label: u.name })),
    [version],
  );
  const officeLocations = useMemo(() => getOfficeLocations(), [version]);
  const officeOptions: PickerOption[] = useMemo(
    () => officeLocations.map(l => ({ id: l.id, label: l.name })),
    [officeLocations],
  );

  function resetAll() {
    setLocationValue(null);
    setShelfValue(null);
    setJobValue(null);
    setManagerValue(null);
    setManagerLocs([]);
    setManagerLocValue(null);
    setOfficeValue(null);
  }

  function selectType(opt: DestType) {
    resetAll();
    setDestType(opt);
    // Office with a single base resolves immediately.
    if (opt === 'office' && officeLocations.length === 1) {
      const loc = officeLocations[0];
      setOfficeValue({ id: loc.id, label: loc.name });
      onResolved({ type: 'office', label: loc.name, toLocationId: loc.id, jobId: null });
      return;
    }
    onResolved(null);
  }

  // ── Location (+ optional dynamic shelf) ──────────────────────────────────────
  // The location list is shelf-free and unit-free (LocationShelfPicker reads
  // getNonShelfLocations): shelves come back only as the Shelf sub-field of a
  // has_shelves parent, and vehicles/lockers never appear here (they're reached
  // via Manager). Unlike the item-assign pickers it DOES include type-less
  // locations (#158, includeTypeless): any real place is a valid checkout
  // destination even before it's been given a type. Because selecting a
  // destination IS the commit in this flow, a
  // has_shelves location must NOT auto-commit on the location tap — it waits for
  // a shelf pick (or the explicit "no shelf" button). Shelf-free locations keep
  // the one-tap behaviour.
  function commitLocation(loc: PickerOption, shelf: PickerOption | null) {
    const res = resolveLocationShelfSelection(
      { id: loc.id, label: loc.label },
      shelf ? { id: shelf.id, label: shelf.label } : null,
    );
    if (!res.ok) {
      Alert.alert('Couldn’t create shelf', `Something went wrong saving shelf “${res.shelfLabel}”. Please try again.`);
      onResolved(null);
      return;
    }
    if (res.id == null) { onResolved(null); return; }
    const label = shelf ? `${loc.label} › ${shelf.label}` : loc.label;
    onResolved({ type: 'location', label, toLocationId: res.id, jobId: null });
  }
  function changeLocation(opt: PickerOption | null) {
    setLocationValue(opt);
    setShelfValue(null);
    if (!opt) { onResolved(null); return; }
    // Defer commit until a shelf (or "no shelf") is chosen for shelf-bearing
    // locations; commit straight away for the shelf-free common case.
    if (getLocationById(opt.id)?.has_shelves === 1) { onResolved(null); return; }
    commitLocation(opt, null);
  }
  function changeShelf(opt: PickerOption | null) {
    setShelfValue(opt);
    if (locationValue && opt) commitLocation(locationValue, opt);
    else onResolved(null);
  }

  // ── Job ────────────────────────────────────────────────────────────────────
  function selectJob(opt: PickerOption) {
    setJobValue(opt);
    onResolved({ type: 'job', label: opt.label, toLocationId: null, jobId: opt.id });
  }
  function createJob(text: string) {
    if (!user) return;
    if (isWriteBlocked()) {
      // no inline job creation during maintenance lockout — say why instead of
      // silently doing nothing when the user taps "create".
      Alert.alert('Maintenance in progress', 'Can’t create a job right now. Try again once maintenance finishes.');
      return;
    }
    const now = new Date().toISOString();
    const newJob: Job = {
      id: generateUUID(), name: text, status: 'open',
      created_by: user.id, created_at: now, updated_at: now, synced_at: null,
    };
    try {
      // upsert + outbox + log are one logical unit — wrap them so a mid-flow
      // failure can't strand a job row without its outbox entry / log.
      runInTransaction(() => {
        upsertJob(newJob);
        // Strip the device-local-only synced_at before queueing — the server jobs
        // table has no such column and would reject the row (stranding it + its logs).
        const { synced_at: _sa, ...jobRow } = newJob;
        appendOutbox('INSERT', 'jobs', jobRow);
        appendLog({
          action: 'job_created', entity_type: 'job', entity_id: newJob.id,
          user_id: user.id, team_id: null, from_location_id: null, to_location_id: null,
          quantity: null, unit: null, job_id: newJob.id, note: newJob.name,
          metadata: null, device_id: null,
        });
      });
    } catch (e) {
      // Don't select a job that didn't actually persist.
      Alert.alert('Couldn’t create job', 'Something went wrong saving the new job. Please try again.');
      return;
    }
    setJobValue({ id: newJob.id, label: newJob.name });
    onResolved({ type: 'job', label: newJob.name, toLocationId: null, jobId: newJob.id });
  }

  // ── Manager ──────────────────────────────────────────────────────────────────
  // #162: a manager-owned location is usually a UNIT (vehicle/locker). Sending
  // stock INTO another team's unit is locked without manage_other_team_inventory
  // — say why and keep the destination unresolved (confirm stays disabled).
  function blockIfForeignUnit(locId: string): boolean {
    const lock = getUnitInventoryLock(user, locId);
    if (!lock.locked) return false;
    Alert.alert('Team inventory', lock.reason ?? 'This unit belongs to another team.');
    onResolved(null);
    return true;
  }
  function selectManager(opt: PickerOption) {
    setManagerValue(opt);
    setManagerLocValue(null);
    const locs = getLocationsByOwner(opt.id);
    if (locs.length === 1) {
      setManagerLocs([]);
      const loc = locs[0];
      if (blockIfForeignUnit(loc.id)) return;
      onResolved({ type: 'manager', label: `${opt.label} → ${loc.name}`, toLocationId: loc.id, jobId: null });
    } else if (locs.length > 1) {
      setManagerLocs(locs);
      onResolved(null); // incomplete until they pick which location
    } else {
      // Manager owns no location — there is nowhere to credit the item, so this
      // is NOT a usable destination. Keep the choice unresolved (confirm stays
      // disabled) and tell the user why instead of resolving to an empty target.
      setManagerLocs([]);
      onResolved(null);
      Alert.alert(
        'No location for this manager',
        `${opt.label} doesn’t own a location yet. Pick a different destination, or assign them a location first.`,
      );
    }
  }
  function selectManagerLoc(opt: PickerOption) {
    setManagerLocValue(opt);
    if (blockIfForeignUnit(opt.id)) return;
    onResolved({
      type: 'manager',
      label: `${managerValue?.label ?? ''} → ${opt.label}`,
      toLocationId: opt.id, jobId: null,
    });
  }

  // ── Office ─────────────────────────────────────────────────────────────────
  function selectOffice(opt: PickerOption) {
    setOfficeValue(opt);
    onResolved({ type: 'office', label: opt.label, toLocationId: opt.id, jobId: null });
  }

  const managerLocOptions: PickerOption[] = managerLocs.map(l => {
    const lock = getUnitInventoryLock(user, l.id);
    return { id: l.id, label: l.name, sublabel: lock.locked ? lock.reason ?? '🔒 Team inventory' : undefined };
  });

  return (
    <View>
      <Text style={s.label}>Destination</Text>
      <View style={s.forRow}>
        {(['location', 'job', 'manager', 'office'] as const).map(opt => (
          <TouchableOpacity
            key={opt}
            style={[s.forBtn, destType === opt && s.forBtnActive]}
            onPress={() => selectType(opt)}
          >
            <Text style={[s.forBtnText, destType === opt && s.forBtnTextActive]}>
              {opt === 'location' ? 'Location' : opt === 'job' ? 'Job' : opt === 'manager' ? 'Manager' : 'Office'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {destType === 'location' && (
        <View style={{ marginTop: 12 }}>
          <LocationShelfPicker
            proximitySort
            includeTypeless
            locationValue={locationValue}
            shelfValue={shelfValue}
            onChangeLocation={changeLocation}
            onChangeShelf={changeShelf}
          />
          {locationValue && getLocationById(locationValue.id)?.has_shelves === 1 && (
            <TouchableOpacity style={s.noShelfBtn} onPress={() => commitLocation(locationValue, null)}>
              <Text style={s.noShelfBtnText}>Send to {locationValue.label} (no shelf)</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {destType === 'job' && (
        <View style={{ marginTop: 12 }}>
          <SearchablePicker
            placeholder={canCreateJobs ? 'Search or create a job...' : 'Search jobs...'}
            options={jobOptions}
            value={jobValue}
            onSelect={selectJob}
            onCreate={canCreateJobs ? createJob : undefined}
          />
        </View>
      )}

      {destType === 'manager' && (
        <View style={{ marginTop: 12 }}>
          <SearchablePicker
            placeholder="Pick a manager..."
            options={managerOptions}
            value={managerValue}
            onSelect={selectManager}
          />
          {managerLocs.length > 1 && (
            <View style={{ marginTop: 8 }}>
              <SearchablePicker
                placeholder="Pick this manager's location..."
                options={managerLocOptions}
                value={managerLocValue}
                onSelect={selectManagerLoc}
              />
            </View>
          )}
        </View>
      )}

      {destType === 'office' && officeLocations.length !== 1 && (
        <View style={{ marginTop: 12 }}>
          {officeLocations.length === 0 ? (
            <Text style={s.empty}>No office locations found</Text>
          ) : (
            <SearchablePicker
              placeholder="Pick an office..."
              options={officeOptions}
              value={officeValue}
              onSelect={selectOffice}
            />
          )}
        </View>
      )}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  label: { fontSize: 13, fontWeight: '700', color: t.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 16, marginBottom: 8 },
  empty: { textAlign: 'center', color: t.colors.textMuted, marginTop: 20 },
  forRow: { flexDirection: 'row', gap: 8 },
  forBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 8,
    backgroundColor: t.colors.surfaceAlt, alignItems: 'center',
  },
  forBtnActive: { backgroundColor: t.colors.primaryBgStrong },
  forBtnText: { fontSize: 14, color: t.colors.textSecondary, fontWeight: '600' },
  forBtnTextActive: { color: t.colors.primaryText },
  noShelfBtn: {
    marginTop: 10, paddingVertical: 10, borderRadius: 8,
    backgroundColor: t.colors.surfaceAlt, alignItems: 'center',
  },
  noShelfBtnText: { fontSize: 14, color: t.colors.textSecondary, fontWeight: '600' },
});
