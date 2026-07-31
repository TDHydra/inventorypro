import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, StyleSheet } from 'react-native';
import { EntityEditSheet } from '../ui/EntityEditSheet';
import { TextField } from '../ui/TextField';
import { StatusPill } from '../ui/StatusPill';
import { TaxonomyChips } from '../pickers';
import { getLocationById, upsertLocation } from '../../db/queries/locations';
import {
  getVehicle, upsertVehicleState, createServiceRecord, getOdometerTimeline,
  VEHICLE_MODEL_CATEGORY, type VehicleStatePatch,
} from '../../db/queries/vehicles';
import { getUserById } from '../../db/queries/users';
import { runInTransaction } from '../../db/tx';
import { appendOutbox } from '../../sync/outbox';
import { isWriteBlocked } from '../../db/maintenance';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { validateName, parseOptionalCount } from '../../lib/validation';
import { canManageVehicle, canLiftVehicleLockFor } from '../../db/queries/access';
import { track } from '../../telemetry';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  locationId: string;
  visible: boolean;
  onClose: () => void;
}

/**
 * Edit a vehicle's identity/spec: name, model, truck mount, debris option
 * (#152). Equipment spec lives here (not the panel) — see #122 follow-up.
 * #155 widened access: the OWNER can open this sheet without edit_inventory,
 * but sees only the shared-access rows (lock + open_checkout); identity/spec
 * stays editor-only. #167: an existing lock set by a higher tier renders
 * read-only here — canLiftVehicleLockFor gates flipping it off.
 */
export function VehicleEditSheet({ locationId, visible, onClose }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  const isEditor = usePermission('edit_inventory');

  const [name, setName] = useState('');
  const [model, setModel] = useState<{ id: string | null; label: string | null }>({ id: null, label: null });
  const [truckMount, setTruckMount] = useState(false);
  const [debrisOption, setDebrisOption] = useState(false);
  const [checkoutLocked, setCheckoutLocked] = useState(false);
  const [openCheckout, setOpenCheckout] = useState(false);
  const [hasOwner, setHasOwner] = useState(false);
  // #165: owner / tier-3+ / same-team tier-2 manager (canManageVehicle).
  const [canLock, setCanLock] = useState(false);
  // #167: may flip an EXISTING lock off (tier >= locker's tier, or self/legacy).
  const [canLift, setCanLift] = useState(true);
  const [lockerName, setLockerName] = useState<string | null>(null);
  const [nameError, setNameError] = useState('');
  // Current odometer, seeded from the newest odometer-bearing service record.
  // Editing it writes a NEW 'Odometer update' service record (the odometer
  // lives on the timeline, not a vehicles column), so the roll/history update.
  const [odometer, setOdometer] = useState('');
  const [odoSeed, setOdoSeed] = useState<number | null>(null);
  const [odoError, setOdoError] = useState('');

  // Re-seed the form each time the sheet opens: it edits the CURRENT row, and a
  // sync pull while closed must not leave stale initial values behind. While
  // open, the fields are user-owned — no reactive re-reads.
  useEffect(() => {
    if (!visible) return;
    const location = getLocationById(locationId);
    const vehicle = getVehicle(locationId);
    setName(location?.name ?? '');
    setModel({ id: vehicle?.model_id ?? null, label: vehicle?.model ?? null });
    setTruckMount(!!vehicle?.truck_mount);
    setDebrisOption(!!vehicle?.debris_option);
    setCheckoutLocked(!!vehicle?.checkout_locked);
    setOpenCheckout(!!vehicle?.open_checkout);
    setHasOwner(location?.owner_user_id != null);
    setCanLock(canManageVehicle(user, location ?? null));
    setCanLift(canLiftVehicleLockFor(user, location ?? null, vehicle));
    setLockerName(vehicle?.locked_by ? getUserById(vehicle.locked_by)?.name ?? null : null);
    setNameError('');
    const latestOdo = getOdometerTimeline(locationId, 1)[0]?.odometer ?? null;
    setOdoSeed(latestOdo);
    setOdometer(latestOdo != null ? String(latestOdo) : '');
    setOdoError('');
  }, [visible, locationId, user]);

  // EntityEditSheet contract: throw to keep the sheet open; return to close.
  function handleSave() {
    if (isWriteBlocked()) throw new Error('write blocked');
    const location = getLocationById(locationId);
    if (!location) throw new Error('vehicle location missing');

    let newName = location.name;
    if (isEditor) {
      const nameResult = validateName(name);
      if (!nameResult.ok) {
        track('audit', 'validation_reject', { screen: 'vehicle_edit', props: { field: 'vehicle.name', rule: nameResult.rule } });
        setNameError(nameResult.error);
        throw new Error(`validation: ${nameResult.rule}`);
      }
      newName = nameResult.value;
    }
    setNameError('');
    let odoValue: number | null = null;
    if (isEditor) {
      const odoResult = parseOptionalCount(odometer, 'Odometer');
      if (!odoResult.ok) {
        track('audit', 'validation_reject', { screen: 'vehicle_edit', props: { field: 'vehicle.odometer', rule: odoResult.rule } });
        setOdoError(odoResult.error);
        throw new Error(`validation: ${odoResult.rule}`);
      }
      odoValue = odoResult.value;
    }
    setOdoError('');
    const now = new Date().toISOString();

    // Each holder patches only the fields their gate covers; everything else
    // stays untouched so concurrent writers don't clobber each other.
    const patch: VehicleStatePatch = {
      ...(isEditor ? {
        model: model.label, model_id: model.id,
        truck_mount: truckMount ? 1 : 0,
        debris_option: debrisOption ? 1 : 0,
      } : {}),
      // #167: only include the lock when the caller may write the transition —
      // locking ON needs canLock; flipping an existing lock OFF also needs canLift.
      ...(canLock && (canLift || checkoutLocked) ? { checkout_locked: checkoutLocked ? 1 : 0 } : {}),
      ...(canLock && hasOwner ? { open_checkout: openCheckout ? 1 : 0 } : {}),
    };

    try {
      // Atomic: renamed location + its outbox entry + the vehicle spec write
      // (which appends its own outbox + vehicle_state_changed log) land together.
      runInTransaction(() => {
        if (isEditor && newName !== location.name) {
          const updated = { ...location, name: newName, updated_at: now, synced_at: null };
          upsertLocation(updated);
          // synced_at is local-only — strip from the outbox payload (server has
          // no such column); active as boolean mirrors VehicleQuickAdd.
          const {
            synced_at: _s,
            type_id: _typeId,
            active,
            subareas_require_owner,
            has_shelves,
            ...locRow
          } = updated;
          appendOutbox('INSERT', 'locations', {
            ...locRow,
            active: active === 1,
            subareas_require_owner: !!subareas_require_owner,
            has_shelves: !!has_shelves,
          });
        }
        if (Object.keys(patch).length > 0) {
          upsertVehicleState(locationId, patch, user?.id ?? null);
        }
      });
    } catch (err) {
      Alert.alert('Save failed', err instanceof Error ? err.message : 'Unknown error');
      throw err;
    }

    // Outside the transaction above — createServiceRecord opens its own.
    // Only a CHANGED reading writes a record; re-saving the seeded value no-ops.
    if (isEditor && odoValue != null && odoValue !== odoSeed) {
      try {
        createServiceRecord({
          vehicleLocationId: locationId,
          target: 'vehicle',
          eventDate: now,
          type: 'Odometer update',
          odometer: odoValue,
          userId: user?.id ?? null,
        });
      } catch (err) {
        Alert.alert('Save failed', err instanceof Error ? err.message : 'Unknown error');
        throw err;
      }
    }
  }

  return (
    <EntityEditSheet visible={visible} onClose={onClose} title="Edit Vehicle" onSave={handleSave}>
      {isEditor && (
        <>
          <TextField
            label="Name"
            required
            value={name}
            onChangeText={v => { setName(v); if (nameError) setNameError(''); }}
            error={nameError || null}
          />
          <TaxonomyChips
            category={VEHICLE_MODEL_CATEGORY}
            label="Model"
            deselectable
            valueId={model.id}
            valueLabel={model.label}
            onChange={setModel}
          />
          <TextField
            label="Odometer (mi)"
            value={odometer}
            onChangeText={v => { setOdometer(v); if (odoError) setOdoError(''); }}
            placeholder="e.g. 84200"
            keyboardType="numeric"
            error={odoError || null}
          />
          <Pressable onPress={() => setTruckMount(v => !v)} style={s.truckRow}>
            <StatusPill
              label={truckMount ? 'Truck mount' : 'No truck mount'}
              tone={truckMount ? 'primary' : 'neutral'}
            />
            <Text style={s.toggleHint}>tap to toggle</Text>
          </Pressable>
          {/* #152: debris tracker is equipment spec like the truck mount. */}
          <Pressable onPress={() => setDebrisOption(v => !v)} style={s.truckRow}>
            <StatusPill
              label={debrisOption ? 'Debris tracker' : 'No debris tracker'}
              tone={debrisOption ? 'primary' : 'neutral'}
            />
            <Text style={s.toggleHint}>tap to toggle</Text>
          </Pressable>
        </>
      )}
      {/* #157/#167: lock row. Not liftable → read-only display, no hint. */}
      {canLock && (canLift || !checkoutLocked ? (
        <Pressable onPress={() => setCheckoutLocked(v => !v)} style={s.truckRow}>
          <StatusPill
            label={checkoutLocked ? '🔒 Locked from checkout' : 'Checkout open'}
            tone={checkoutLocked ? 'warning' : 'neutral'}
          />
          <Text style={s.toggleHint}>tap to toggle</Text>
        </Pressable>
      ) : (
        <Pressable style={s.truckRow} disabled>
          <StatusPill label={`🔒 Locked by ${lockerName ?? 'a manager'}`} tone="warning" />
        </Pressable>
      ))}
      {/* #155: owner opt-in — meaningful only on owned vehicles. Wording is
          deliberately distinct from the lock's "Checkout open". */}
      {canLock && hasOwner && (
        <Pressable onPress={() => setOpenCheckout(v => !v)} style={s.truckRow}>
          <StatusPill
            label={openCheckout ? 'Anyone can check out' : 'Owner-only'}
            tone={openCheckout ? 'primary' : 'neutral'}
          />
          <Text style={s.toggleHint}>tap to toggle</Text>
        </Pressable>
      )}
    </EntityEditSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  truckRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, marginBottom: t.spacing.base },
  toggleHint: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted },
});
