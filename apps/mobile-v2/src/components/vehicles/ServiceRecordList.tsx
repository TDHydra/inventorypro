import { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Card, StatusPill, useThemedStyles, type Theme } from '@invenpro/ui';
import { useTableVersion } from '@invenpro/core';
import { AddServiceRecordSheet } from './AddServiceRecordSheet';
import { getServiceRecords } from '../../repos/vehicles';
import { serviceTargetLabel, serviceTypeLabel } from './vehicleSessionLogic';
import { usePermission } from '../../hooks/usePermission';
import { useMaintenanceMode } from '../../hooks/useMaintenanceMode';
import { formatMoney } from '../../equipment/depreciation';

// Vehicle service history card — the vehicle-side sibling of the equipment
// "Maintenance & Lifecycle" block. Shows the newest `limit` records with a
// target pill for truck-mount/both entries; cost is view_financial_data-gated
// (the server already omits it from pull for everyone else). Owns the
// AddServiceRecordSheet.
//
// Station C3 deviation from apps/mobile: the receipt-photo indicator (📷,
// backed by getMediaForEntity) is CUT — no media module exists in mobile-v2
// yet (TODO(wave-media), matching the AddServiceRecordSheet photo-upload cut
// below and the Station C1 equipment-photo precedent).
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
  // Which kind the sheet opens on. The fuel-up button lands DIRECTLY on the
  // receipt form (For-payer / gallons) — identical to the QuickAdd gas
  // receipt — instead of relying on the small Entry segment inside the sheet.
  const [addKind, setAddKind] = useState<'service' | 'fuel_up'>('service');

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
                {!!r.payer && <Text style={s.rowSub}>For: {r.payer}</Text>}
                {!!r.notes && <Text style={s.rowSub}>{r.notes}</Text>}
              </View>
              {canViewFinancial && r.cost != null && (
                <Text style={s.cost}>{formatMoney(r.cost)}</Text>
              )}
            </View>
          ))
        )}
        {/* #168: UNGATED — receipts merged into this sheet, and any crew
            member may file one. Non-editors get the sheet locked to the
            Fuel-up kind; service records stay editor-only inside. */}
        <View style={s.btnRow}>
          {canEdit && (
            <TouchableOpacity style={s.addBtn} onPress={() => { setAddKind('service'); setAddOpen(true); }} disabled={locked}>
              <Text style={s.addText}>+ Log service</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={s.addBtn} onPress={() => { setAddKind('fuel_up'); setAddOpen(true); }} disabled={locked}>
            <Text style={s.addText}>+ ⛽ Fuel-up / receipt</Text>
          </TouchableOpacity>
        </View>
      </Card>

      <AddServiceRecordSheet
        locationId={locationId}
        visible={addOpen}
        initialKind={addKind}
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
  btnRow: { flexDirection: 'row', gap: t.spacing.sm, marginTop: t.spacing.sm },
  addBtn: {
    alignSelf: 'flex-start',
    borderRadius: t.radii.md,
    paddingHorizontal: t.spacing.md,
    paddingVertical: t.spacing.xs,
    backgroundColor: t.colors.primaryBg,
  },
  addText: { fontSize: t.typography.fontSizes.xs, fontWeight: '700', color: t.colors.primaryText },
});
