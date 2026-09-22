import { View, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

export function Card({ variant = 'list', style, children }: { variant?: 'list' | 'detail'; style?: object; children: React.ReactNode }) {
  const s = useThemedStyles(makeStyles);
  return <View style={[variant === 'detail' ? s.detail : s.list, style]}>{children}</View>;
}
const makeStyles = (t: Theme) => StyleSheet.create({
  list: { backgroundColor: t.colors.surface, borderRadius: t.radii.md, borderWidth: t.components.card.borderWidth, borderColor: t.colors.border, padding: t.spacing.base },
  detail: { backgroundColor: t.colors.surface, borderRadius: t.radii.card, borderWidth: t.components.card.borderWidth, borderColor: t.colors.borderDetail, padding: t.spacing.lg },
});
