import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { colors, radii, spacing, fontSizes } from '../../theme';

export function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={[s.chip, active && s.chipActive]} onPress={onPress} activeOpacity={0.8}>
      <Text style={[s.text, active && s.textActive]}>{label}</Text>
    </TouchableOpacity>
  );
}
const s = StyleSheet.create({
  chip: { backgroundColor: '#F1F5F9', borderRadius: radii.xl, paddingHorizontal: spacing.base, paddingVertical: spacing.sm },
  chipActive: { backgroundColor: colors.primaryBgStrong },
  text: { fontSize: fontSizes.body2, color: colors.textSecondary, fontWeight: '600' },
  textActive: { color: colors.primaryText },
});
