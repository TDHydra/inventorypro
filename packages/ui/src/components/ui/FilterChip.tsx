import { TouchableOpacity, Text, StyleSheet } from 'react-native';
import { KIT_HIT_SLOP } from './hitSlop';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

// #288: `disabled` dims the chip and swallows taps. Added for chip rows that
// choose WHAT a form targets — once the target is fixed (a repair opened for a
// specific unit), switching the chip would silently clear it. The active chip
// still reads as selected when disabled; it's locked, not deselected.
export function FilterChip({ label, active, onPress, disabled }: { label: string; active: boolean; onPress: () => void; disabled?: boolean }) {
  const s = useThemedStyles(makeStyles);
  return (
    <TouchableOpacity
      style={[s.chip, active && s.chipActive, disabled && s.chipDisabled]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.8}
      hitSlop={KIT_HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active, disabled: !!disabled }}
    >
      <Text style={[s.text, active && s.textActive, disabled && s.textDisabled]}>{label}</Text>
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
    chipDisabled: { opacity: 0.55 },
    text: { fontSize: t.typography.fontSizes.body2, color: t.colors.textSecondary, fontWeight: '600' },
    textActive: { color: t.colors.primaryText },
    textDisabled: { color: t.colors.textDisabled },
  });
};
