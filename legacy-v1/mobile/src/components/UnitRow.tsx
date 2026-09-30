import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { EquipmentUnit } from '../db/queries/equipmentUnits';
import type { Theme } from '../themes/types';
import { useTheme } from '../hooks/useTheme';
import { useThemedStyles } from '../hooks/useThemedStyles';
import { StatusPill } from './ui/StatusPill';

type Props = {
  unit: EquipmentUnit;
  locationName?: string | null;
  onRepairOut?: () => void;
  onRepairIn?: () => void;
};

function statusColors(t: Theme, status: string): { bg: string; text: string } {
  switch (status) {
    case 'available': return { bg: t.colors.successBg, text: t.colors.successText };
    case 'deployed':  return { bg: t.colors.primaryBgStrong, text: t.colors.primaryText };
    case 'in_repair': return { bg: t.colors.warningBg, text: t.colors.warningText };
    case 'retired':   return { bg: t.colors.surfaceAlt, text: t.colors.textSecondary };
    default:          return { bg: t.colors.surfaceAlt, text: t.colors.textSecondary };
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
  const s = useThemedStyles(makeStyles);
  const t = useTheme();
  const statusClr = statusColors(t, unit.status);
  const hasActions = !!onRepairOut || !!onRepairIn;

  return (
    <View style={s.row}>
      <View style={s.info}>
        <Text style={s.tag}>{unit.asset_tag}</Text>
        {!!unit.serial_number && <Text style={s.serial}>S/N: {unit.serial_number}</Text>}
        {!!locationName && <Text style={s.location}>{locationName}</Text>}
        {unit.cleanliness === 'dirty' && (
          <View style={{ marginTop: 2, alignSelf: 'flex-start' }}>
            <StatusPill label="Needs cleaning" tone="warning" />
          </View>
        )}
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

const makeStyles = (t: Theme) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    gap: 8,
  },
  info: { flex: 1 },
  tag: { fontSize: 15, color: t.colors.textPrimary, fontWeight: '600' },
  serial: { fontSize: 12, color: t.colors.textMuted, marginTop: 1 },
  location: { fontSize: 12, color: t.colors.textSecondary, marginTop: 2 },
  right: { alignItems: 'flex-end', gap: 6 },
  badge: { borderRadius: 10, paddingHorizontal: 10, paddingVertical: 4 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 6 },
  actionBtn: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  repairOutBtn: { backgroundColor: t.colors.warningBg },
  repairOutText: { fontSize: 12, fontWeight: '700', color: t.colors.warningText },
  repairInBtn: { backgroundColor: t.colors.successBg },
  repairInText: { fontSize: 12, fontWeight: '700', color: t.colors.successText },
});
