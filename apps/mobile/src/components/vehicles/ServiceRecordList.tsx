import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Card } from '../ui/Card';
import { StatusPill } from '../ui/StatusPill';
import { AddServiceRecordSheet } from './AddServiceRecordSheet';
import { getServiceRecords } from '../../db/queries/vehicles';
import { serviceTargetLabel, serviceTypeLabel } from './vehicleSessionLogic';
import { usePermission } from '../../hooks/usePermission';
import { useTableVersion } from '../../hooks/useDataVersion';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { formatMoney } from '../../equipment/depreciation';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

// Vehicle service history card — the vehicle-side sibling of the equipment
// "Maintenance & Lifecycle" block. Shows the newest `limit` records with a
// target pill for truck-mount/both entries; cost is view_financial_data-gated
// (the server already omits it from pull for everyone else). Owns the
// AddServiceRecordSheet (FormSheet first adopter) behind "+ Log service".
interface Props {
  locationId: string;
  limit?: number;
}

export function ServiceRecordList({ locationId, limit = 3 }: Props) {
  const s = useThemedStyles(makeStyles);
  const canEdit = usePermission('edit_inventory');
  const canViewFinancial = usePermission('view_financial_data');
  const { locked } = useMaintenanceMode();
  const version = useTableVersion(['vehicle_service_records']);
  const [addOpen, setAddOpen] = useState(false);

  const records = useMemo(
    () => getServiceRecords(locationId, limit),
    [locationId, limit, version],
  );

  return (
    <>
      <Text style={s.sectionLabel}>Service</Text>
      <Card variant="detail">
        {records.length === 0 ? (
          <Text style={s.empty}>No service logged.</Text>
        ) : (
          records.map((r, i) => (
            <View key={r.id} style={[s.row, i < records.length - 1 && s.divider]}>
              <View style={s.rowMain}>
                <View style={s.rowHeader}>
                  <Text style={s.rowTitle}>
                    {new Date(r.event_date).toLocaleDateString()} · {serviceTypeLabel(r.type)}
                  </Text>
                  {r.target !== 'vehicle' && (
                    <StatusPill label={serviceTargetLabel(r.target)} tone="accent" />
                  )}
                </View>
                {r.odometer != null && <Text style={s.rowSub}>{r.odometer.toLocaleString()} mi</Text>}
                {!!r.notes && <Text style={s.rowSub}>{r.notes}</Text>}
              </View>
              {canViewFinancial && r.cost != null && (
                <Text style={s.cost}>{formatMoney(r.cost)}</Text>
              )}
            </View>
          ))
        )}
        {canEdit && (
          <TouchableOpacity style={s.addBtn} onPress={() => setAddOpen(true)} disabled={locked}>
            <Text style={s.addText}>+ Log service</Text>
          </TouchableOpacity>
        )}
      </Card>

      <AddServiceRecordSheet
        locationId={locationId}
        visible={addOpen}
        onClose={() => setAddOpen(false)}
      />
    </>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  sectionLabel: {
    fontSize: t.typography.fontSizes.xs,
    fontWeight: '700',
    color: t.colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: t.spacing.xs,
  },
  empty: { fontSize: t.typography.fontSizes.sm, color: t.colors.textMuted },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: t.spacing.md,
    paddingVertical: t.spacing.sm,
  },
  divider: { borderBottomWidth: 1, borderBottomColor: t.colors.surfaceAlt },
  rowMain: { flex: 1 },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm, flexWrap: 'wrap' },
  rowTitle: { fontSize: t.typography.fontSizes.body, color: t.colors.textPrimary, fontWeight: '600' },
  rowSub: { fontSize: t.typography.fontSizes.sm, color: t.colors.textSecondary, marginTop: 2, lineHeight: 18 },
  cost: { fontSize: t.typography.fontSizes.body, fontWeight: '700', color: t.colors.textPrimary },
  addBtn: {
    alignSelf: 'flex-start',
    borderRadius: t.radii.md,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.xs,
    backgroundColor: t.colors.primaryBg,
    marginTop: t.spacing.sm,
  },
  addText: { fontSize: t.typography.fontSizes.xs, fontWeight: '700', color: t.colors.primaryText },
});
