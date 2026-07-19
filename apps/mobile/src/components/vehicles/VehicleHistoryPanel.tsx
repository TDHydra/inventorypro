import { useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Card } from '../ui/Card';
import { StatusPill } from '../ui/StatusPill';
import { ServiceRecordList } from './ServiceRecordList';
import {
  getCheckoutHistory, getOdometerTimeline, getFuelUps,
} from '../../db/queries/vehicles';
import {
  formatSince, serviceTypeLabel, parseFuelUpGallons, odometerDeltas,
} from './vehicleSessionLogic';
import { usePermission } from '../../hooks/usePermission';
import { useTableVersion } from '../../hooks/useDataVersion';
import { formatMoney } from '../../equipment/depreciation';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

/**
 * THE embeddable vehicle-history surface (#141): sessions (driver/times/job),
 * odometer timeline with per-interval miles, and fuel-ups — anywhere a vehicle
 * is clicked. Self-loads from locationId (VehiclePanel precedent) and stays
 * reactive to sync. Service history itself lives in ServiceRecordList; pass
 * `includeService` when embedding somewhere that doesn't already render it.
 */
interface Props {
  locationId: string;
  sessionsLimit?: number;
  includeService?: boolean;
}

export function VehicleHistoryPanel({ locationId, sessionsLimit = 5, includeService = false }: Props) {
  const s = useThemedStyles(makeStyles);
  const canViewFinancial = usePermission('view_financial_data');
  const version = useTableVersion(['vehicle_checkouts', 'vehicle_service_records']);

  const sessions = useMemo(
    () => getCheckoutHistory(locationId, sessionsLimit),
    [locationId, sessionsLimit, version],
  );
  const odometer = useMemo(() => getOdometerTimeline(locationId), [locationId, version]);
  const deltas = useMemo(() => odometerDeltas(odometer), [odometer]);
  const fuelUps = useMemo(() => getFuelUps(locationId), [locationId, version]);

  return (
    <View style={s.container}>
      {/* Checkout sessions */}
      <Text style={s.sectionLabel}>Usage</Text>
      <Card variant="detail">
        {sessions.length === 0 ? (
          <Text style={s.muted}>No sessions yet.</Text>
        ) : (
          sessions.map((c, i) => (
            <View key={c.id} style={[s.row, i < sessions.length - 1 && s.divider]}>
              <View style={s.rowMain}>
                <Text style={s.rowTitle}>{c.user_name ?? c.user_id}</Text>
                <Text style={s.rowSub}>
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

      {/* Odometer timeline */}
      <Text style={s.sectionLabel}>Miles</Text>
      <Card variant="detail">
        {odometer.length === 0 ? (
          <Text style={s.muted}>No odometer readings yet.</Text>
        ) : (
          odometer.map((r, i) => (
            <View key={r.id} style={[s.row, i < odometer.length - 1 && s.divider]}>
              <View style={s.rowMain}>
                <Text style={s.rowTitle}>{r.odometer.toLocaleString()} mi</Text>
                <Text style={s.rowSub}>
                  {new Date(r.event_date).toLocaleDateString()} · {serviceTypeLabel(r.type)}
                </Text>
              </View>
              {deltas[i] != null && deltas[i]! > 0 && (
                <Text style={s.delta}>+{deltas[i]!.toLocaleString()}</Text>
              )}
            </View>
          ))
        )}
      </Card>

      {/* Fuel-ups */}
      <Text style={s.sectionLabel}>Fuel-ups</Text>
      <Card variant="detail">
        {fuelUps.length === 0 ? (
          <Text style={s.muted}>No fuel-ups logged.</Text>
        ) : (
          fuelUps.map((r, i) => {
            const gallons = parseFuelUpGallons(r.notes);
            return (
              <View key={r.id} style={[s.row, i < fuelUps.length - 1 && s.divider]}>
                <View style={s.rowMain}>
                  <Text style={s.rowTitle}>
                    {new Date(r.event_date).toLocaleDateString()}
                    {gallons != null ? ` · ${gallons} gal` : ''}
                  </Text>
                  {r.odometer != null && <Text style={s.rowSub}>{r.odometer.toLocaleString()} mi</Text>}
                </View>
                {canViewFinancial && r.cost != null && (
                  <Text style={s.cost}>{formatMoney(r.cost)}</Text>
                )}
              </View>
            );
          })
        )}
      </Card>

      {includeService && <ServiceRecordList locationId={locationId} limit={3} />}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  container: { gap: t.spacing.sm },
  sectionLabel: {
    fontSize: t.typography.fontSizes.sm,
    fontWeight: '700',
    color: t.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: t.spacing.sm,
  },
  muted: { fontSize: t.typography.fontSizes.body, color: t.colors.textSecondary },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: t.spacing.sm,
  },
  divider: { borderBottomWidth: 1, borderBottomColor: t.colors.border },
  rowMain: { flex: 1 },
  rowTitle: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.textPrimary },
  rowSub: { fontSize: t.typography.fontSizes.sm, color: t.colors.textSecondary, marginTop: 2 },
  delta: { fontSize: t.typography.fontSizes.sm, fontWeight: '600', color: t.colors.textSecondary },
  cost: { fontSize: t.typography.fontSizes.body, fontWeight: '600', color: t.colors.textPrimary },
});
