import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, StyleSheet } from 'react-native';
import { EntityEditSheet } from '../ui/EntityEditSheet';
import { TextField } from '../ui/TextField';
import { StatusPill } from '../ui/StatusPill';
import { TaxonomyChips } from '../pickers';
import { getLocationById, upsertLocation } from '../../db/queries/locations';
import { getVehicle, upsertVehicleState, VEHICLE_MODEL_CATEGORY } from '../../db/queries/vehicles';
import { runInTransaction } from '../../db/tx';
import { appendOutbox } from '../../sync/outbox';
import { isWriteBlocked } from '../../db/maintenance';
import { useSession } from '../../hooks/useSession';
import { validateName } from '../../lib/validation';
import { canManageVehicle } from '../../db/queries/access';
import { track } from '../../telemetry';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  locationId: string;
  visible: boolean;
  onClose: () => void;
}

/**
 * Edit a vehicle's identity/spec: name, model, truck mount. Truck mount lives
 * here (and in VehicleQuickAdd) rather than on the panel because it's equipment
 * spec, not day-to-day state like the tanks — see #122 follow-up. Callers gate
 * visibility on edit_inventory; day-to-day tank state stays ungated on the panel.
 */
export function VehicleEditSheet({ locationId, visible, onClose }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();

  const [name, setName] = useState('');
  const [model, setModel] = useState<{ id: string | null; label: string | null }>({ id: null, label: null });
  const [truckMount, setTruckMount] = useState(false);
  const [checkoutLocked, setCheckoutLocked] = useState(false);
  // #165: owner / tier-3+ / same-team tier-2 manager (canManageVehicle)
  // — everyone else neither sees it nor writes checkout_locked.
  const [canLock, setCanLock] = useState(false);
  const [nameError, setNameError] = useState('');

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
    setCheckoutLocked(!!vehicle?.checkout_locked);
    // #165: owner, tier-3+, or a tier-2 manager on the owner's team.
    setCanLock(canManageVehicle(user, location ?? null));
    setNameError('');
  }, [visible, locationId, user]);

  // EntityEditSheet contract: throw to keep the sheet open; return to close.
  function handleSave() {
    if (isWriteBlocked()) throw new Error('write blocked');
    const location = getLocationById(locationId);
    if (!location) throw new Error('vehicle location missing');

    const nameResult = validateName(name);
    if (!nameResult.ok) {
      track('audit', 'validation_reject', { screen: 'vehicle_edit', props: { field: 'vehicle.name', rule: nameResult.rule } });
      setNameError(nameResult.error);
      throw new Error(`validation: ${nameResult.rule}`);
    }
    setNameError('');
    const now = new Date().toISOString();

    try {
      // Atomic: renamed location + its outbox entry + the vehicle spec write
      // (which appends its own outbox + vehicle_state_changed log) land together.
      runInTransaction(() => {
        if (nameResult.value !== location.name) {
          const updated = { ...location, name: nameResult.value, updated_at: now, synced_at: null };
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
        upsertVehicleState(locationId, {
          model: model.label, model_id: model.id,
          truck_mount: truckMount ? 1 : 0,
          // Only the owner/authority patch the lock — others leave it untouched.
          ...(canLock ? { checkout_locked: checkoutLocked ? 1 : 0 } : {}),
        }, user?.id ?? null);
      });
    } catch (err) {
      Alert.alert('Save failed', err instanceof Error ? err.message : 'Unknown error');
      throw err;
    }
  }

  return (
    <EntityEditSheet visible={visible} onClose={onClose} title="Edit Vehicle" onSave={handleSave}>
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
      <Pressable onPress={() => setTruckMount(v => !v)} style={s.truckRow}>
        <StatusPill
          label={truckMount ? 'Truck mount' : 'No truck mount'}
          tone={truckMount ? 'primary' : 'neutral'}
        />
        <Text style={s.toggleHint}>tap to toggle</Text>
      </Pressable>
      {/* #157: owner lock — vehicle stays visible everywhere, checkout is
          blocked for everyone but the owner / tier-3+ authority. */}
      {canLock && (
        <Pressable onPress={() => setCheckoutLocked(v => !v)} style={s.truckRow}>
          <StatusPill
            label={checkoutLocked ? '🔒 Locked from checkout' : 'Checkout open'}
            tone={checkoutLocked ? 'warning' : 'neutral'}
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
