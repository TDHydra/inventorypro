import { useEffect, useMemo } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { getNonShelfLocations, getShelvesForParent } from '../../db/queries/locations';
import { SearchablePicker, PickerOption } from '../SearchablePicker';
import { FieldLabel } from '../ui/FieldLabel';
import { LocationPicker } from './LocationPicker';
import { useCurrentPosition } from '../../hooks/useCurrentPosition';
import { sortByProximity } from '../../location/proximity';

// The two-stage location→shelf field that inventory/add hand-rolls (add.tsx's
// location SearchablePicker + the conditional Shelf one below it), extracted once.
// The location list is shelf-free (getNonShelfLocations): shelves appear ONLY via
// the Shelf sub-field of their has_shelves parent, never as first-class options.
// The caller holds both selections as PickerOptions; the component owns the
// coupling between them: a shelf belongs to its parent, so any location change
// clears the shelf, and the Shelf field only exists while the chosen location has
// has_shelves = 1 (a SQLite 1/0 int).
//
// Persistence stays with the caller: a typed-in shelf is reported as the existing
// `{ id: '__new__', label }` sentinel and the call site decides when to
// findOrCreateShelf(). This component never writes to the DB (getShelvesForParent
// is a read).
//
// `proximitySort` is opt-in. LocationPicker can't order by distance (its options
// are a mount-only, coords-agnostic map), so that path renders SearchablePicker
// directly with proximity-sorted options; the plain path reuses LocationPicker.
export function LocationShelfPicker({
  locationValue,
  shelfValue,
  onChangeLocation,
  onChangeShelf,
  proximitySort,
  excludeIds,
}: {
  locationValue: PickerOption | null;
  shelfValue: PickerOption | null;
  onChangeLocation: (opt: PickerOption | null) => void;
  onChangeShelf: (opt: PickerOption | null) => void;
  proximitySort?: boolean;
  // Location ids to hide from the location options (e.g. a transfer's source
  // location). Doesn't touch the Shelf sub-field.
  excludeIds?: string[];
}) {
  const t = useTheme();
  // useCurrentPosition is platform-resolved: the native hook imports expo-location,
  // the .web.ts sibling uses navigator.geolocation — so no native module reaches
  // the web bundle. Off → we never call request(), so no permission prompt and no
  // location work; coords stays null and sortByProximity degrades to source order.
  const { coords, request } = useCurrentPosition();
  useEffect(() => {
    if (proximitySort) void request();
  }, [proximitySort, request]);

  const allLocations = useMemo(() => getNonShelfLocations(), []);
  const locationById = useMemo(
    () => new Map(allLocations.map(l => [l.id, l])),
    [allLocations],
  );

  // Proximity-ordered options (parent + distance sublabels), mirroring add.tsx's
  // locationOptions. Only consumed by the proximitySort branch; harmless otherwise.
  const locationOptions = useMemo<PickerOption[]>(() => {
    const candidates = excludeIds?.length
      ? allLocations.filter(l => !excludeIds.includes(l.id))
      : allLocations;
    const sorted = sortByProximity(
      candidates.map(l => ({ ...l, latitude: l.latitude ?? null, longitude: l.longitude ?? null })),
      coords,
    );
    return sorted.map(l => {
      const parentName = l.parent_id ? locationById.get(l.parent_id)?.name : undefined;
      const distLabel = l.distanceM != null ? `~${Math.round(l.distanceM)} m` : undefined;
      const sublabel = [parentName, distLabel].filter(Boolean).join(' · ') || undefined;
      return { id: l.id, label: l.name, sublabel };
    });
  }, [allLocations, coords, locationById, excludeIds]);

  // has_shelves gates the Shelf field; shelves are scoped to the chosen parent.
  const selectedFull = locationValue ? locationById.get(locationValue.id) : undefined;
  const locationHasShelves = selectedFull?.has_shelves === 1;
  const shelfOptions = useMemo<PickerOption[]>(
    () => (locationHasShelves && locationValue)
      ? getShelvesForParent(locationValue.id).map(s => ({ id: s.id, label: s.name }))
      : [],
    [locationHasShelves, locationValue],
  );

  // Any location change clears the shelf (shelf is per-location). Combined with
  // clear-on-retap: re-tapping the current location deselects it.
  const changeLocation = (opt: PickerOption | null) => {
    onChangeShelf(null);
    onChangeLocation(opt);
  };

  return (
    <>
      {proximitySort ? (
        <SearchablePicker
          placeholder="Search locations..."
          options={locationOptions}
          value={locationValue}
          onSelect={opt => changeLocation(locationValue && opt.id === locationValue.id ? null : opt)}
        />
      ) : (
        // LocationPicker already does clear-on-retap and hands us the final value.
        <LocationPicker
          value={locationValue}
          onChange={changeLocation}
          placeholder="Search locations..."
          filter={excludeIds ? l => !excludeIds.includes(l.id) : undefined}
        />
      )}
      {locationHasShelves && (
        <>
          <FieldLabel style={{ marginTop: t.spacing.md }}>Shelf</FieldLabel>
          <SearchablePicker
            placeholder="Type or pick a shelf (e.g. A1)…"
            options={shelfOptions}
            value={shelfValue}
            onSelect={opt => onChangeShelf(shelfValue && opt.id === shelfValue.id ? null : opt)}
            // A typed-in shelf isn't a row yet: report the sentinel; the call site
            // resolves it via findOrCreateShelf at submit.
            onCreate={text => onChangeShelf({ id: '__new__', label: text })}
          />
        </>
      )}
    </>
  );
}
