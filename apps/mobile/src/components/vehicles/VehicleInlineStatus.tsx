import { useMemo } from 'react';
import { View, StyleSheet } from 'react-native';
import { StatusPill } from '../ui/StatusPill';
import { getVehicleInlineStatus } from '../../db/queries/vehicles';
import { useTableVersion } from '../../hooks/useDataVersion';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

/**
 * List-row status pills for Vehicle-typed locations — deliberately CHEAP:
 * one memoized single-statement query keyed on the two tables it reads, no
 * focus hooks (list screens re-render rows themselves). Renders nothing when
 * there's no state to show (no vehicles row, no open session).
 */
export function VehicleInlineStatus({ locationId }: { locationId: string }) {
  const s = useThemedStyles(makeStyles);
  const version = useTableVersion(['vehicles', 'vehicle_checkouts']);
  const status = useMemo(() => getVehicleInlineStatus(locationId), [locationId, version]);

  const hasHolder = !!status.holder_name;
  // #159: tanks belong to the truck-mount rig — never surface tank pills on a
  // vehicle without one (stale tank state can linger after the rig is removed).
  const truckMount = !!status.truck_mount;
  const waterFull = truckMount && status.water_tank === 'full';
  const wasteDirty = truckMount && status.waste_tank === 'dirty';
  if (!hasHolder && !waterFull && !wasteDirty) return null;

  return (
    <View style={s.row}>
      {hasHolder && <StatusPill label={`Out · ${status.holder_name}`} tone="warning" />}
      {waterFull && <StatusPill label="💧 Water full" tone="primary" />}
      {wasteDirty && <StatusPill label="⚠️ Waste dirty" tone="warning" />}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.xs, marginTop: t.spacing.xs },
});
