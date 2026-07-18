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
  const hasWater = status.water_state === 'full' || status.water_state === 'empty_clean';
  if (!hasHolder && !hasWater) return null;

  return (
    <View style={s.row}>
      {hasHolder && <StatusPill label={`Out · ${status.holder_name}`} tone="warning" />}
      {hasWater && (
        <StatusPill
          label={status.water_state === 'full' ? '💧 Full' : 'Empty·clean'}
          tone={status.water_state === 'full' ? 'primary' : 'neutral'}
        />
      )}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.xs, marginTop: t.spacing.xs },
});
