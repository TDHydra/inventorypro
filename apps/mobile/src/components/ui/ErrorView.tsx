import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={s.wrap}>
      <Text style={s.msg}>{message}</Text>
      {onRetry ? (
        <TouchableOpacity style={s.btn} onPress={onRetry} activeOpacity={0.85}>
          <Text style={s.btnText}>Retry</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}
const makeStyles = (t: Theme) => StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', padding: t.spacing.xl, gap: t.spacing.md },
  msg: { fontSize: t.typography.fontSizes.body, color: t.colors.danger, textAlign: 'center' },
  btn: { borderWidth: 1, borderColor: t.colors.border, borderRadius: t.radii.md, paddingHorizontal: t.spacing.lg, paddingVertical: t.spacing.sm },
  btnText: { color: t.colors.primaryText, fontWeight: '700', fontSize: t.typography.fontSizes.body },
});
