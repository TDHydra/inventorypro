import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';

export function LoadingView({ label }: { label?: string }) {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);
  return (
    <View style={s.wrap}>
      <ActivityIndicator size="large" color={t.colors.primary} />
      {label ? <Text style={s.label}>{label}</Text> : null}
    </View>
  );
}
const makeStyles = (t: Theme) => StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', padding: t.spacing.xxl, gap: t.spacing.md },
  label: { fontSize: t.typography.fontSizes.body2, color: t.colors.textMuted },
});
