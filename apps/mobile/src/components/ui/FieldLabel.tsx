import { Text, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

export function FieldLabel({ children, style }: { children: string; style?: object }) {
  const s = useThemedStyles(makeStyles);
  return <Text style={[s.label, style]}>{children}</Text>;
}
const makeStyles = (t: Theme) => StyleSheet.create({
  label: {
    fontSize: t.typography.fontSizes.caption,
    color: t.colors.textSecondary,
    fontFamily: t.typography.fontFamily.medium,
    textTransform: 'uppercase',
    // uppercaseLabels themes drive weight/tracking from the theme; otherwise the
    // pre-theme literals (parity on Original).
    ...(t.typography.uppercaseLabels
      ? { fontWeight: t.typography.weights.semibold, letterSpacing: t.typography.letterSpacing }
      : { fontWeight: '700' as const, letterSpacing: 0.5 }),
  },
});
