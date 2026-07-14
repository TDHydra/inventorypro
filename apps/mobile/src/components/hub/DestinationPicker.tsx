import { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { SearchablePicker, type PickerOption } from '../SearchablePicker';
import { useCurrentPosition } from '../../hooks/useCurrentPosition';
import { sortByProximity } from '../../location/proximity';
import { getOpenJobs, upsertJob, type Job } from '../../db/queries/jobs';
import { getManagerTierUsers } from '../../db/queries/users';
import {
  getOfficeLocations, getLocationsByOwner, searchLocations, type Location,
} from '../../db/queries/locations';
import { appendOutbox } from '../../sync/outbox';
import { appendLog } from '../../db/queries/log';
import { generateUUID } from '../../utils/uuid';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { isWriteBlocked } from '../../db/maintenance';
import { runInTransaction } from '../../db/tx';
import { Alert } from '../../lib/themedAlert';
import { colors } from '../../theme';

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
  const { user } = useSession();
  const canCreateJobs = usePermission('create_jobs');

  // Position: request once when the Location picker opens (fire-and-forget; never
  // blocks UI). Coords feed the searchFn's proximity sort below.
  const { coords, request } = useCurrentPosition();

  const [destType, setDestType] = useState<DestType | null>(null);
  const [locationValue, setLocationValue] = useState<PickerOption | null>(null);
  const [jobValue, setJobValue] = useState<PickerOption | null>(null);
  const [managerValue, setManagerValue] = useState<PickerOption | null>(null);
  const [managerLocs, setManagerLocs] = useState<Location[]>([]);
  const [managerLocValue, setManagerLocValue] = useState<PickerOption | null>(null);
  const [officeValue, setOfficeValue] = useState<PickerOption | null>(null);

  const jobOptions: PickerOption[] = useMemo(
    () => getOpenJobs().map(j => ({ id: j.id, label: j.name })),
    [],
  );
  const managerOptions: PickerOption[] = useMemo(
    () => getManagerTierUsers().map(u => ({ id: u.id, label: u.name })),
    [],
  );
  const officeLocations = useMemo(() => getOfficeLocations(), []);
  const officeOptions: PickerOption[] = useMemo(
    () => officeLocations.map(l => ({ id: l.id, label: l.name })),
    [officeLocations],
  );

  // Ask for the device position once the Location picker is opened, so its
  // searchFn can proximity-sort results. Fire-and-forget; degrades silently.
  useEffect(() => {
    if (destType === 'location') void request();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [destType]);

  function resetAll() {
    setLocationValue(null);
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

  // ── Location ───────────────────────────────────────────────────────────────
  function selectLocation(opt: PickerOption) {
    setLocationValue(opt);
    onResolved({ type: 'location', label: opt.label, toLocationId: opt.id, jobId: null });
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
          latitude: coords?.latitude ?? null,
          longitude: coords?.longitude ?? null,
          location_accuracy: coords?.accuracy ?? null,
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
  function selectManager(opt: PickerOption) {
    setManagerValue(opt);
    setManagerLocValue(null);
    const locs = getLocationsByOwner(opt.id);
    if (locs.length === 1) {
      setManagerLocs([]);
      const loc = locs[0];
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

  const managerLocOptions: PickerOption[] = managerLocs.map(l => ({ id: l.id, label: l.name }));

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
          <SearchablePicker
            placeholder="Search location..."
            value={locationValue}
            onSelect={selectLocation}
            searchFn={(q) => {
              const results = searchLocations(q);
              // Without coords yet, keep the existing (name-ordered) behaviour.
              if (!coords) return results.map(l => ({ id: l.id, label: l.name }));
              // Proximity-sort this keystroke's results; un-anchored locations
              // (no lat/lng) sink to the bottom in their original order.
              return sortByProximity(
                results.map(l => ({ ...l, latitude: l.latitude ?? null, longitude: l.longitude ?? null })),
                coords,
              ).map(l => ({
                id: l.id,
                label: l.name,
                sublabel: l.distanceM != null ? `~${Math.round(l.distanceM)} m` : undefined,
              }));
            }}
          />
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

const s = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5, marginTop: 16, marginBottom: 8 },
  empty: { textAlign: 'center', color: colors.textMuted, marginTop: 20 },
  forRow: { flexDirection: 'row', gap: 8 },
  forBtn: {
    flex: 1, paddingVertical: 10, borderRadius: 8,
    backgroundColor: '#F1F5F9', alignItems: 'center',
  },
  forBtnActive: { backgroundColor: colors.primaryBgStrong },
  forBtnText: { fontSize: 14, color: colors.textSecondary, fontWeight: '600' },
  forBtnTextActive: { color: colors.primaryText },
});
