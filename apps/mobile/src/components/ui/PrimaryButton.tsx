import { ActivityIndicator, Pressable, StyleSheet, Text, TouchableHighlight, TouchableOpacity } from 'react-native';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props { label: string; onPress: () => void; disabled?: boolean; loading?: boolean; tone?: 'primary' | 'danger'; style?: object; }
export function PrimaryButton({ label, onPress, disabled, loading, tone = 'primary', style }: Props) {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);
  const soft = t.components.button.variant === 'soft';
  const bg = soft
    ? (tone === 'danger' ? t.colors.dangerBg : t.colors.primaryBg)
    : (tone === 'danger' ? t.colors.danger : t.colors.primary);
  const fg = soft
    ? (tone === 'danger' ? t.colors.danger : t.colors.primaryText)
    : t.colors.onPrimary;
  // Glow = fab shadow recolored to the fill (web helper maps it to a boxShadow glow).
  const glow = t.components.button.variant === 'filled-glow'
    ? { borderWidth: 1, borderColor: bg, ...t.shadows.fab, shadowColor: bg, shadowOpacity: 0.6, shadowRadius: 8 }
    : null;
  const inactive = disabled || loading;
  const btnStyle = [s.btn, { backgroundColor: bg }, glow, inactive && s.disabled, style];
  const content = loading ? <ActivityIndicator color={fg} /> : <Text style={[s.text, { color: fg }]}>{label}</Text>;
  // #219: same a11y surface on all three press-feedback variants — the label
  // must be explicit because the loading state replaces the Text child.
  const a11y = {
    accessibilityRole: 'button' as const,
    accessibilityLabel: label,
    accessibilityState: { disabled: inactive, busy: !!loading },
  };

  if (t.motion.pressFeedback === 'scale') {
    return (
      <Pressable {...a11y} style={({ pressed }) => [...btnStyle, pressed && s.pressed]} onPress={onPress} disabled={inactive}>
        {content}
      </Pressable>
    );
  }
  if (t.motion.pressFeedback === 'highlight') {
    return (
      <TouchableHighlight
        {...a11y}
        style={btnStyle}
        underlayColor={tone === 'danger' ? t.colors.dangerBg : t.colors.primaryBgStrong}
        onPress={onPress}
        disabled={inactive}
      >
        {content}
      </TouchableHighlight>
    );
  }
  return (
    <TouchableOpacity {...a11y} style={btnStyle} onPress={onPress} disabled={inactive} activeOpacity={0.85}>
      {content}
    </TouchableOpacity>
  );
}
const makeStyles = (t: Theme) => StyleSheet.create({
  btn: {
    paddingVertical: 13, borderRadius: t.radii.button, alignItems: 'center', justifyContent: 'center',
    minHeight: t.components.button.minHeight,
  },
  pressed: { transform: [{ scale: 0.97 }] },
  disabled: { opacity: 0.5 },
  text: {
    color: t.colors.onPrimary,
    fontWeight: t.typography.weights.bold,
    fontSize: t.typography.fontSizes.base,
    fontFamily: t.typography.fontFamily.bold,
    letterSpacing: t.typography.letterSpacing,
    textTransform: t.components.button.textTransform,
  },
});
