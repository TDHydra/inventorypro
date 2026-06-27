import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { colors, spacing, fontSizes } from '../../theme';

export function LoadingView({ label }: { label?: string }) {
  return (
    <View style={s.wrap}>
      <ActivityIndicator size="large" color={colors.primary} />
      {label ? <Text style={s.label}>{label}</Text> : null}
    </View>
  );
}
const s = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', padding: spacing.xxl, gap: spacing.md },
  label: { fontSize: fontSizes.body2, color: colors.textMuted },
});
