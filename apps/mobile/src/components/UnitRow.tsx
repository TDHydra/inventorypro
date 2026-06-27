import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { EquipmentUnit } from '../db/queries/equipmentUnits';
import { colors } from '../theme';

type Props = {
  unit: EquipmentUnit;
  locationName?: string | null;
  onRepairOut?: () => void;
  onRepairIn?: () => void;
};

function statusColors(status: string): { bg: string; text: string } {
  switch (status) {
    case 'available': return { bg: '#D1FAE5', text: '#065F46' };
    case 'deployed':  return { bg: colors.primaryBgStrong, text: colors.primaryText };
    case 'in_repair': return { bg: '#FEF3C7', text: '#92400E' };
    case 'retired':   return { bg: '#F1F5F9', text: '#64748B' };
    default:          return { bg: '#F1F5F9', text: '#64748B' };
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'available': return 'Available';
    case 'deployed':  return 'Deployed';
    case 'in_repair': return 'In Repair';
    case 'retired':   return 'Retired';
    default:          return status;
  }
}

export function UnitRow({ unit, locationName, onRepairOut, onRepairIn }: Props) {
  const statusClr = statusColors(unit.status);
  const hasActions = !!onRepairOut || !!onRepairIn;

  return (
    <View style={s.row}>
      <View style={s.info}>
        <Text style={s.tag}>{unit.asset_tag}</Text>
        {!!unit.serial_number && <Text style={s.serial}>S/N: {unit.serial_number}</Text>}
        {!!locationName && <Text style={s.location}>{locationName}</Text>}
      </View>
      <View style={s.right}>
        <View style={[s.badge, { backgroundColor: statusClr.bg }]}>
          <Text style={[s.badgeText, { color: statusClr.text }]}>{statusLabel(unit.status)}</Text>
        </View>
        {hasActions && (
          <View style={s.actions}>
            {onRepairOut && (
              <TouchableOpacity style={[s.actionBtn, s.repairOutBtn]} onPress={onRepairOut}>
                <Text style={s.repairOutText}>Repair</Text>
              </TouchableOpacity>
            )}
            {onRepairIn && (
              <TouchableOpacity style={[s.actionBtn, s.repairInBtn]} onPress={onRepairIn}>
                <Text style={s.repairInText}>Return</Text>
              </TouchableOpacity>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 8,
  },
  info: { flex: 1 },
  tag: { fontSize: 15, color: colors.textPrimary, fontWeight: '600' },
  serial: { fontSize: 12, color: colors.textMuted, marginTop: 1 },
  location: { fontSize: 12, color: colors.textSecondary, marginTop: 2 },
  right: { alignItems: 'flex-end', gap: 6 },
  badge: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 6 },
  actionBtn: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  repairOutBtn: { backgroundColor: '#FEF3C7' },
  repairOutText: { fontSize: 12, fontWeight: '700', color: '#92400E' },
  repairInBtn: { backgroundColor: '#D1FAE5' },
  repairInText: { fontSize: 12, fontWeight: '700', color: '#065F46' },
});
