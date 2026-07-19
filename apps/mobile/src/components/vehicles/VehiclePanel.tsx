import { useMemo, useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Card } from '../ui/Card';
import { KeyValueRow } from '../ui/KeyValueRow';
import { TypeBadge } from '../ui/StatusBadge';
import { StatusPill } from '../ui/StatusPill';
import { SegmentedControl } from '../ui/SegmentedControl';
import { PrimaryButton } from '../ui/PrimaryButton';
import { FieldLabel } from '../ui/FieldLabel';
import { confirmSheet } from '../ui/ConfirmSheet';
import { ServiceRecordList } from './ServiceRecordList';
import { UnitContentsPanel } from '../units/UnitContentsPanel';
import { VehicleCheckoutSheet, type CheckoutSheetMode } from './VehicleCheckoutSheet';
import {
  getVehicle, upsertVehicleState, getActiveCheckout, getCheckoutHistory,
  checkInVehicle, VEHICLE_MODEL_CATEGORY, type WaterTank, type WasteTank,
} from '../../db/queries/vehicles';
import { getLocationById } from '../../db/queries/locations';
import { getUserById } from '../../db/queries/users';
import { getTaxonomyTypes } from '../../db/queries/taxonomy';
import {
  resolveCheckoutAction, formatSince, waterTankLabel, wasteTankLabel,
} from './vehicleSessionLogic';
import { renderIcon } from '../../constants/locationStyles';
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
  const canCheckout = usePermission('checkout_inventory');
  const { locked } = useMaintenanceMode();

  // Refocus + per-table pull granularity: re-read when the screen regains focus
  // or a sync pull touches one of the vehicle tables (both inputs only grow).
  const focusKey = useFocusOrDataRefresh();
  const tableKey = useTableVersion(['vehicles', 'vehicle_checkouts', 'vehicle_service_records']);
  const refreshKey = focusKey + tableKey;

  const location = useMemo(() => getLocationById(locationId), [locationId, refreshKey]);
  const vehicle = useMemo(() => getVehicle(locationId), [locationId, refreshKey]);
  const active = useMemo(() => getActiveCheckout(locationId), [locationId, refreshKey]);
  const history = useMemo(
    () => (variant === 'full' ? getCheckoutHistory(locationId, 5) : []),
    [locationId, variant, refreshKey],
  );
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

  function setWaterTank(id: string) {
    if (isWriteBlocked()) return;
    upsertVehicleState(locationId, { water_tank: id as WaterTank }, user?.id ?? null);
  }

  function setWasteTank(id: string) {
    if (isWriteBlocked()) return;
    upsertVehicleState(locationId, { waste_tank: id as WasteTank }, user?.id ?? null);
  }

  function toggleTruckMount() {
    if (isWriteBlocked()) return;
    upsertVehicleState(locationId, { truck_mount: vehicle?.truck_mount ? 0 : 1 }, user?.id ?? null);
  }

  async function onPrimaryPress() {
    if (isWriteBlocked()) return;
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

  const header = (
    <View>
      <View style={s.headerRow}>
        <Text style={s.name} numberOfLines={1}>{location.icon ? `${renderIcon(location.icon)} ` : ''}{location.name}</Text>
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
      <StatusPill
        label={waterTankLabel(vehicle?.water_tank ?? 'empty')}
        tone={vehicle?.water_tank === 'full' ? 'primary' : 'neutral'}
      />
      <StatusPill
        label={wasteTankLabel(vehicle?.waste_tank ?? 'clean')}
        tone={vehicle?.waste_tank === 'dirty' ? 'warning' : 'neutral'}
      />

      <StatusPill
        label={isOut ? `Out · ${holderName}` : 'Available'}
        tone={isOut ? 'warning' : 'success'}
      />
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
      </Card>

      {/* State: truck mount + water. Both write upsertVehicleState (creates the
          extension row on first write when it's missing). Deliberately NOT
          permission-gated — the server accepts `vehicles` writes from any
          authed device (OPERATION_PERM null), and the whole point is a helper
          marking the tank emptied without edit_inventory. */}
      <Text style={s.sectionLabel}>State</Text>
      <Card variant="detail">
        <Pressable onPress={locked ? undefined : toggleTruckMount} style={s.truckRow}>
          <StatusPill
            label={vehicle?.truck_mount ? 'Truck mount' : 'No truck mount'}
            tone={vehicle?.truck_mount ? 'primary' : 'neutral'}
          />
          {!locked && <Text style={s.toggleHint}>tap to toggle</Text>}
        </Pressable>
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
        {canCheckout && (
          <PrimaryButton
            label={action.kind === 'check_in' ? 'Check In' : action.kind === 'take_over' ? 'Take Over' : 'Check Out'}
            onPress={() => { void onPrimaryPress(); }}
            tone={action.kind === 'take_over' ? 'danger' : 'primary'}
            disabled={locked}
            style={s.primaryBtn}
          />
        )}
      </Card>

      {/* Contents (A2 Task 5) — per-action gated list + add/remove/move. */}
      <Text style={s.sectionLabel}>Contents</Text>
      <Card variant="detail">
        <UnitContentsPanel locationId={locationId} />
      </Card>

      {/* Service log (last 3 + add) */}
      <ServiceRecordList locationId={locationId} limit={3} />

      {/* Usage history (last 5 sessions) */}
      <Text style={s.sectionLabel}>Usage</Text>
      <Card variant="detail">
        {history.length === 0 ? (
          <Text style={s.muted}>No sessions yet.</Text>
        ) : (
          history.map((c, i) => (
            <View key={c.id} style={[s.histRow, i < history.length - 1 && s.divider]}>
              <View style={s.histMain}>
                <Text style={s.histTitle}>{c.user_name ?? c.user_id}</Text>
                <Text style={s.histSub}>
                  {new Date(c.checked_out_at).toLocaleDateString()}
                  {c.checked_in_at
                    ? ` · ${formatSince(c.checked_out_at, c.checked_in_at) || '<1m'}`
                    : ' · still out'}
                  {c.job_name ? ` · ${c.job_name}` : ''}
                </Text>
              </View>
              {c.checked_in_at == null && <StatusPill label="Open" tone="warning" />}
            </View>
          ))
        )}
      </Card>

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
  truckRow: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm },
  toggleHint: { fontSize: t.typography.fontSizes.xs, color: t.colors.textMuted },
  waterLabel: { marginTop: t.spacing.md },
  muted: { fontSize: t.typography.fontSizes.sm, color: t.colors.textMuted },
  primaryBtn: { marginTop: t.spacing.md },
  histRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: t.spacing.md,
    paddingVertical: t.spacing.sm,
  },
  divider: { borderBottomWidth: 1, borderBottomColor: t.colors.surfaceAlt },
  histMain: { flex: 1 },
  histTitle: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.textPrimary },
  histSub: { fontSize: t.typography.fontSizes.sm, color: t.colors.textSecondary, marginTop: 2 },
});
