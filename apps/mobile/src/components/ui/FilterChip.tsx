import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

export function FilterChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const s = useThemedStyles(makeStyles);
  return (
    <TouchableOpacity style={[s.chip, active && s.chipActive]} onPress={onPress} activeOpacity={0.8}>
      <Text style={[s.text, active && s.textActive]}>{label}</Text>
    </TouchableOpacity>
  );
}
const makeStyles = (t: Theme) => {
  const squareTag = t.components.chip.variant === 'square-tag';
  return StyleSheet.create({
    chip: {
      backgroundColor: t.colors.surfaceAlt,
      borderRadius: squareTag ? t.radii.sm : t.radii.xl,
      paddingHorizontal: squareTag ? t.spacing.md : t.spacing.base,
      paddingVertical: t.spacing.sm,
    },
    chipActive: { backgroundColor: t.colors.primaryBgStrong },
    text: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, fontWeight: '600' },
    textActive: { color: t.colors.primaryText },
  });
};
