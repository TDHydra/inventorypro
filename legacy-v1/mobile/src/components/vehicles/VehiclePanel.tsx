import { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Alert } from '../../lib/themedAlert';
import { Card } from '../ui/Card';
import { KeyValueRow } from '../ui/KeyValueRow';
import { TypeBadge } from '../ui/StatusBadge';
import { StatusPill } from '../ui/StatusPill';
import { SegmentedControl } from '../ui/SegmentedControl';
import { PrimaryButton } from '../ui/PrimaryButton';
import { FieldLabel } from '../ui/FieldLabel';
import { confirmSheet } from '../ui/ConfirmSheet';
import { ServiceRecordList } from './ServiceRecordList';
import { VehicleHistoryPanel } from './VehicleHistoryPanel';
import { UnitContentsPanel } from '../units/UnitContentsPanel';
import { VehicleCheckoutSheet, type CheckoutSheetMode } from './VehicleCheckoutSheet';
import { VehicleEditSheet } from './VehicleEditSheet';
import {
  getVehicle, upsertVehicleState, getActiveCheckout,
  checkInVehicle, VEHICLE_MODEL_CATEGORY, type WaterTank, type WasteTank,
} from '../../db/queries/vehicles';
import { getLocationById, retireVehicle, reactivateVehicle } from '../../db/queries/locations';
import { getUserById } from '../../db/queries/users';
import { getTaxonomyTypes } from '../../db/queries/taxonomy';
import {
  resolveCheckoutAction, formatSince, waterTankLabel, wasteTankLabel,
  resolveVehicleAvailability, snapDebrisLevel, snapFuelLevel,
} from './vehicleSessionLogic';
import { VerticalLevelSlider } from '../ui/VerticalLevelSlider';
import { renderIcon } from '../../constants/locationStyles';
import { canManageVehicle, canLiftVehicleLockFor } from '../../db/queries/access';
import { useSession } from '../../hooks/useSession';
import { usePermission } from '../../hooks/usePermission';
import { useTableVersion } from '../../hooks/useDataVersion';
import { useFocusOrDataRefresh } from '../../hooks/useFocusOrDataRefresh';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { isWriteBlocked } from '../../db/maintenance';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

/**
 * THE embeddable vehicle surface (#125): tap Frank's van anywhere and this
 * renders its full info in place. Self-loads from locationId; the vehicles
 * extension row may not exist yet (older client / pre-042 location) — every
 * read falls back to defaults, and the first state write creates the row.
 *
 * variant 'full'    — header, state controls, checkout card, service log,
 *                     usage history. Used by VehicleSheet + (vehicles)/[id].
 * variant 'summary' — header + state/checkout pills only. Used as the embed
 *                     above stock on (locations)/[id] (stage C1).
 */
interface Props {
  locationId: string;
  variant: 'full' | 'summary';
  /** When provided, tapping the header navigates (sheet/list tap-throughs). */
  onNavigate?: () => void;
}

const WATER_SEGMENTS = [
  { id: 'full', label: 'Full' },
  { id: 'empty', label: 'Empty' },
];
const WASTE_SEGMENTS = [
  { id: 'clean', label: 'Clean' },
  { id: 'dirty', label: 'Dirty' },
];

export function VehiclePanel({ locationId, variant, onNavigate }: Props) {
  const s = useThemedStyles(makeStyles);
  const { user } = useSession();
  // #155: role never gates VEHICLE checkout — no checkout_inventory check here.
  const canEdit = usePermission('edit_inventory');
  // #153: retire/reactivate is a locations write, so it's gated the same way
  // the personal-locker toggle is (MemberPermissionsSheet) — the outbox UPDATE
  // is server-authorized regardless, this only hides the action in the UI.
  const canManageLocations = usePermission('manage_locations');
  const { locked } = useMaintenanceMode();

  // Refocus + per-table pull granularity: re-read when the screen regains focus
  // or a sync pull touches one of the vehicle tables (both inputs only grow).
  const focusKey = useFocusOrDataRefresh();
  const tableKey = useTableVersion(['vehicles', 'vehicle_checkouts', 'vehicle_service_records']);
  const refreshKey = focusKey + tableKey;

  const location = useMemo(() => getLocationById(locationId), [locationId, refreshKey]);
  const vehicle = useMemo(() => getVehicle(locationId), [locationId, refreshKey]);
  const active = useMemo(() => getActiveCheckout(locationId), [locationId, refreshKey]);
  const owner = useMemo(
    () => (location?.owner_user_id ? getUserById(location.owner_user_id) : null),
    [location?.owner_user_id, refreshKey],
  );
  // Model icon from the vehicle_model taxonomy (#81) — match by durable id
  // first, label as the grace fallback.
  const modelIcon = useMemo(() => {
    if (!vehicle?.model && !vehicle?.model_id) return undefined;
    const types = getTaxonomyTypes(VEHICLE_MODEL_CATEGORY, { includeInactive: true });
    const match = types.find(t => t.id === vehicle.model_id) ?? types.find(t => t.label === vehicle.model);
    return match?.icon ? renderIcon(match.icon) : undefined;
  }, [vehicle?.model, vehicle?.model_id, refreshKey]);

  const [sheet, setSheet] = useState<{ mode: CheckoutSheetMode; sessionId?: string; initialJobId?: string | null } | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  if (!location) {
    return (
      <Card variant="detail">
        <Text style={s.muted}>Vehicle not found.</Text>
      </Card>
    );
  }

  const action = resolveCheckoutAction(active, user?.id ?? null);
  const nowIso = new Date().toISOString();
  const holderName = active?.user_name ?? active?.user_id ?? '';
  const isOut = action.kind !== 'check_out';
  const isMine = action.kind === 'check_in';
  // #165: shared predicate — owner / tier-3+ / same-team tier-2 manager.
  const canManage = canManageVehicle(user, location);
  // #167: bypass follows unlock — only a caller who could lift the lock passes.
  const canBypassLock = canLiftVehicleLockFor(user, location, vehicle);
  const lockerName = vehicle?.locked_by ? (getUserById(vehicle.locked_by)?.name ?? null) : null;
  const checkoutBlocked = !!vehicle?.checkout_locked && !canBypassLock && action.kind !== 'check_in';
  // #155: owner-aware availability (session state handled by `action` above,
  // so hasOpenSession is false here — this decides the owned/opt-in half only).
  const availability = resolveVehicleAvailability({
    ownerUserId: location.owner_user_id,
    openCheckout: vehicle?.open_checkout ?? 0,
    hasOpenSession: false,
    userId: user?.id ?? null,
  });
  const ownedBlocked = !availability.available && action.kind !== 'check_in';

  function setWaterTank(id: string) {
    if (isWriteBlocked()) return;
    upsertVehicleState(locationId, { water_tank: id as WaterTank }, user?.id ?? null);
  }

  function setWasteTank(id: string) {
    if (isWriteBlocked()) return;
    upsertVehicleState(locationId, { waste_tank: id as WasteTank }, user?.id ?? null);
  }

  async function onPrimaryPress() {
    if (isWriteBlocked()) return;
    if (checkoutBlocked || ownedBlocked) return; // #157/#167 lock, #155 owner-closed

    if (action.kind === 'check_out') {
      setSheet({ mode: 'checkout' });
      return;
    }
    if (action.kind === 'check_in') {
      checkInVehicle(action.sessionId, user?.id ?? null);
      return;
    }
    // Warn-and-take-over (user decision 2026-07-18): confirm BEFORE the job
    // sheet opens so the confirm isn't raised under an open ModalSheet.
    const ok = await confirmSheet({
      title: 'Take over this vehicle?',
      message: `${holderName || 'Someone else'} has it checked out${active ? ` since ${formatSince(active.checked_out_at, nowIso)} ago` : ''}. Taking over will end their session.`,
      confirmLabel: 'Take Over',
      destructive: true,
    });
    if (ok) setSheet({ mode: 'takeover' });
  }

  // #153: retire hides the vehicle from every unit list/picker (getUnitLocations
  // filters active=1, same as lockers) without hard-deleting it. Refuses (via
  // retireVehicle's guards) while checked out or still holding stock — those
  // reasons surface here since the query layer can't raise UI.
  async function onRetirePress() {
    if (isWriteBlocked()) return;
    const ok = await confirmSheet({
      title: 'Retire this vehicle?',
      // Non-null: onRetirePress is only reachable from the full-variant render,
      // which already returned early above when `location` is null.
      message: `${location!.name} will be hidden from vehicle lists. You can reactivate it later.`,
      confirmLabel: 'Retire',
      destructive: true,
    });
    if (!ok) return;
    const res = retireVehicle(locationId, user?.id ?? null);
    if (!res.ok) Alert.alert('Could not retire vehicle', res.reason);
  }

  async function onReactivatePress() {
    if (isWriteBlocked()) return;
    const ok = await confirmSheet({
      title: 'Reactivate this vehicle?',
      message: `${location!.name} will show up in vehicle lists again.`,
      confirmLabel: 'Reactivate',
    });
    if (!ok) return;
    const res = reactivateVehicle(locationId, user?.id ?? null);
    if (!res.ok) Alert.alert('Could not reactivate vehicle', res.reason);
  }

  const header = (
    <View>
      <View style={s.headerRow}>
        <Text style={s.name} numberOfLines={1}>{location.icon ? `${renderIcon(location.icon)} ` : ''}{location.name}</Text>
        {variant === 'full' && (canEdit || location.owner_user_id === user?.id) && !locked && (
          <Pressable onPress={() => setEditOpen(true)} hitSlop={8}>
            <Text style={s.editLink}>Edit</Text>
          </Pressable>
        )}
        {onNavigate && <Text style={s.chevron}>›</Text>}
      </View>
      {!!vehicle?.model && (
        <View style={s.modelRow}>
          <TypeBadge type={vehicle.model} icon={modelIcon} size="md" />
        </View>
      )}
      <KeyValueRow label="Owner" value={owner?.name ?? null} />
    </View>
  );

  const statusPills = (
    <View style={s.pillRow}>
      {!!vehicle?.truck_mount && <StatusPill label="Truck mount" tone="primary" />}
      {/* #159: the tanks belong to the truck-mount rig — no rig, no tank pills. */}
      {!!vehicle?.truck_mount && (
        <StatusPill
          label={waterTankLabel(vehicle?.water_tank ?? 'empty')}
          tone={vehicle?.water_tank === 'full' ? 'primary' : 'neutral'}
        />
      )}
      {!!vehicle?.truck_mount && (
        <StatusPill
          label={wasteTankLabel(vehicle?.waste_tank ?? 'clean')}
          tone={vehicle?.waste_tank === 'dirty' ? 'warning' : 'neutral'}
        />
      )}
      {/* #157/#167: visible-but-locked — everyone sees the lock and who set it;
          only someone who can lift it (tier rule) can still check out. */}
      {!!vehicle?.checkout_locked && (
        <StatusPill label={`🔒 Locked${lockerName ? ` by ${lockerName}` : ''}`} tone="neutral" />
      )}
      {/* #152: debris level rides the pill row whenever the tracker is on. */}
      {!!vehicle?.debris_option && (
        <StatusPill
          label={`Debris ${vehicle?.debris_level ?? 0}%`}
          tone={(vehicle?.debris_level ?? 0) >= 80 ? 'warning' : 'neutral'}
        />
      )}
      {/* #174: fuel gauge — ungated (every vehicle has fuel, unlike debris_option). */}
      <StatusPill
        label={`${vehicle?.fuel_level ?? 0}% fuel`}
        tone={(vehicle?.fuel_level ?? 0) <= 20 ? 'warning' : 'neutral'}
      />

      {/* #153: retired vehicles are filtered out of every list/picker (same
          active=1 filter as lockers), but a stale deep link or the summary
          embed on a location's detail screen can still reach one — flag it
          rather than showing "Available" as if it were live. */}
      {location.active === 1 ? (
        <StatusPill
          label={isOut ? `Out · ${holderName}` : 'Available'}
          tone={isOut ? 'warning' : 'success'}
        />
      ) : (
        <StatusPill label="Retired" tone="danger" />
      )}
    </View>
  );

  // ── summary: header + pills only ─────────────────────────────────────────
  if (variant === 'summary') {
    return (
      <Card variant="detail">
        {onNavigate ? <Pressable onPress={onNavigate}>{header}</Pressable> : header}
        {statusPills}
      </Card>
    );
  }

  // ── full ────────────────────────────────────────────────────────────────
  return (
    <View style={s.stack}>
      <Card variant="detail">
        {onNavigate ? <Pressable onPress={onNavigate}>{header}</Pressable> : header}
        {/* #153: the full variant is the vehicle detail screen the Retire/
            Reactivate button lives on — it needs the same Retired/Available
            pill the summary embed shows, not just the raw button. */}
        {statusPills}
      </Card>

      {/* State: tank levels. Writes upsertVehicleState (creates the extension
          row on first write when it's missing). Deliberately NOT
          permission-gated — the server accepts `vehicles` writes from any
          authed device (OPERATION_PERM null), and the whole point is a helper
          marking the tank emptied without edit_inventory. Truck mount is
          equipment spec, not state — read-only pill here, edited via the
          header Edit sheet (or set at creation in VehicleQuickAdd). */}
      <Text style={s.sectionLabel}>State</Text>
      <Card variant="detail">
        <View style={s.truckRow}>
          <StatusPill
            label={vehicle?.truck_mount ? 'Truck mount' : 'No truck mount'}
            tone={vehicle?.truck_mount ? 'primary' : 'neutral'}
          />
        </View>
        {/* #165/#167: lock toggle — reachable for lock-managers (office/HR have
            no edit_inventory, so the Edit sheet is closed to them). Locking ON
            needs canManage; flipping an existing lock OFF also needs the lift
            rule (tier >= locker's tier). Not liftable → read-only pill. */}
        {canManage && !locked && (
          (vehicle?.checkout_locked ? canBypassLock : true) ? (
            <Pressable
              onPress={() => {
                if (isWriteBlocked()) return;
                upsertVehicleState(
                  locationId,
                  { checkout_locked: vehicle?.checkout_locked ? 0 : 1 },
                  user?.id ?? null,
                );
              }}
              style={s.truckRow}
            >
              <StatusPill
                label={vehicle?.checkout_locked ? '🔒 Locked from checkout' : 'Checkout open'}
                tone={vehicle?.checkout_locked ? 'warning' : 'neutral'}
              />
              <Text style={s.toggleHint}>tap to toggle</Text>
            </Pressable>
          ) : (
            <View style={s.truckRow}>
              <StatusPill label={`🔒 Locked by ${lockerName ?? 'a manager'}`} tone="warning" />
            </View>
          )
        )}
        {/* #159: tank state only exists on truck-mount rigs — hide both rows
            (not just disable) when the vehicle has no truck mount. */}
        {!!vehicle?.truck_mount && (
          <>
            <FieldLabel style={s.waterLabel}>Water tank</FieldLabel>
            {locked ? (
              <Text style={s.muted}>{waterTankLabel(vehicle?.water_tank ?? 'empty')}</Text>
            ) : (
              <SegmentedControl
                segments={WATER_SEGMENTS}
                value={vehicle?.water_tank ?? 'empty'}
                onChange={setWaterTank}
                size="sm"
              />
            )}
            <FieldLabel style={s.waterLabel}>Waste tank</FieldLabel>
            {locked ? (
              <Text style={s.muted}>{wasteTankLabel(vehicle?.waste_tank ?? 'clean')}</Text>
            ) : (
              <SegmentedControl
                segments={WASTE_SEGMENTS}
                value={vehicle?.waste_tank ?? 'clean'}
                onChange={setWasteTank}
                size="sm"
              />
            )}
          </>
        )}
        {/* #152: debris level — independent of the truck mount; drag commits
            snapped to 10s. Ungated like the tanks (crew-level state). */}
        {!!vehicle?.debris_option && (
          <>
            <FieldLabel style={s.waterLabel}>Debris level</FieldLabel>
            {locked ? (
              <Text style={s.muted}>{`${vehicle?.debris_level ?? 0}%`}</Text>
            ) : (
              <VerticalLevelSlider
                value={vehicle?.debris_level ?? 0}
                onCommit={raw => {
                  if (isWriteBlocked()) return;
                  upsertVehicleState(locationId, { debris_level: snapDebrisLevel(raw) }, user?.id ?? null);
                }}
              />
            )}
          </>
        )}
        {/* #174: fuel level — ungated (every vehicle has fuel, unlike the
            debris tracker) and permission-less like the other vehicle state
            writes; drag commits snapped to 10s. */}
        <FieldLabel style={s.waterLabel}>Fuel</FieldLabel>
        {locked ? (
          <Text style={s.muted}>{`${vehicle?.fuel_level ?? 0}%`}</Text>
        ) : (
          <VerticalLevelSlider
            value={vehicle?.fuel_level ?? 0}
            onCommit={raw => {
              if (isWriteBlocked()) return;
              upsertVehicleState(locationId, { fuel_level: snapFuelLevel(raw) }, user?.id ?? null);
            }}
          />
        )}
      </Card>

      {/* Checkout session */}
      <Text style={s.sectionLabel}>Checkout</Text>
      <Card variant="detail">
        {active && isOut ? (
          <>
            <KeyValueRow label="Holder" value={holderName} badge={
              <StatusPill label={isMine ? 'You' : holderName} tone={isMine ? 'success' : 'warning'} />
            } />
            <KeyValueRow label="Since" value={`${formatSince(active.checked_out_at, nowIso)} ago`} />
            {active.job_id ? (
              <KeyValueRow label="Job" value={active.job_name ?? active.job_id} />
            ) : isMine && !locked ? (
              <KeyValueRow
                label="Job"
                value="No job · Add job"
                onPress={() => setSheet({ mode: 'addjob', sessionId: active.id, initialJobId: null })}
              />
            ) : (
              <KeyValueRow label="Job" value="No job" />
            )}
          </>
        ) : (
          <Text style={s.muted}>Not checked out.</Text>
        )}
        {/* #155: no permission wrapper — any role may check out an available
            vehicle; unavailability disables with the reason instead. */}
        <PrimaryButton
          label={
            action.kind === 'check_in' ? 'Check In'
            : ownedBlocked ? `Owned by ${owner?.name ?? 'someone'}`
            : checkoutBlocked ? `🔒 Locked by ${lockerName ?? 'owner'}`
            : action.kind === 'take_over' ? 'Take Over' : 'Check Out'
          }
          onPress={() => { void onPrimaryPress(); }}
          tone={action.kind === 'take_over' && !checkoutBlocked && !ownedBlocked ? 'danger' : 'primary'}
          disabled={locked || checkoutBlocked || ownedBlocked}
          style={s.primaryBtn}
        />
      </Card>

      {/* Contents (A2 Task 5) — per-action gated list + add/remove/move. */}
      <Text style={s.sectionLabel}>Contents</Text>
      <Card variant="detail">
        <UnitContentsPanel locationId={locationId} />
      </Card>

      {/* Service log (last 3 + add) */}
      <ServiceRecordList locationId={locationId} limit={3} />

      {/* Usage / miles / fuel-ups (#141) — the embeddable history surface. */}
      <VehicleHistoryPanel locationId={locationId} />

      {/* #153: retire (hide from lists, never delete) / reactivate — gated on
          manage_locations like the personal-locker toggle. */}
      {canManageLocations && !locked && (
        location.active === 1 ? (
          <PrimaryButton
            label="Retire Vehicle"
            tone="danger"
            onPress={() => { void onRetirePress(); }}
          />
        ) : (
          <PrimaryButton
            label="Reactivate Vehicle"
            onPress={() => { void onReactivatePress(); }}
          />
        )
      )}

      {sheet && (
        <VehicleCheckoutSheet
          locationId={locationId}
          visible
          onClose={() => setSheet(null)}
          mode={sheet.mode}
          sessionId={sheet.sessionId}
          initialJobId={sheet.initialJobId}
        />
      )}
      <VehicleEditSheet locationId={locationId} visible={editOpen} onClose={() => setEditOpen(false)} />
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  stack: { gap: t.spacing.md },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  name: { fontSize: t.typography.fontSizes.xl, fontWeight: '700', color: t.colors.brand, flexShrink: 1 },
  chevron: { fontSize: t.typography.fontSizes.lg, color: t.colors.textMuted, marginLeft: t.spacing.sm },
  modelRow: { flexDirection: 'row', marginTop: t.spacing.sm },
  sectionLabel: {
    fontSize: t.typography.fontSizes.xs,
    fontWeight: '700',
    color: t.colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: t.spacing.xs,
  },
  pillRow: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm, marginTop: t.spacing.md },
  editLink: { fontSize: t.typography.fontSizes.sm, fontWeight: '600', color: t.colors.brand, marginLeft: t.spacing.sm },
  truckRow: { flexDirection: 'row', alignItems: 'center' },
  toggleHint: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted },
  waterLabel: { marginTop: t.spacing.md },
  muted: { fontSize: t.typography.fontSizes.sm, color: t.colors.textMuted },
  primaryBtn: { marginTop: t.spacing.md },
});
