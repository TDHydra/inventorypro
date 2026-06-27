import { View, StyleSheet } from 'react-native';
import { colors, radii, spacing } from '../../theme';

export function Card({ variant = 'list', style, children }: { variant?: 'list' | 'detail'; style?: object; children: React.ReactNode }) {
  return <View style={[variant === 'detail' ? s.detail : s.list, style]}>{children}</View>;
}
const s = StyleSheet.create({
  list: { backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, padding: spacing.base },
  detail: { backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.borderDetail, padding: spacing.lg },
});
