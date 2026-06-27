import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, spacing, fontSizes, radii } from '../../theme';

export function ErrorView({ message, onRetry }: { message: string; onRetry?: () => void }) {
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
const s = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.md },
  msg: { fontSize: fontSizes.body, color: colors.danger, textAlign: 'center' },
  btn: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  btnText: { color: colors.primaryText, fontWeight: '700', fontSize: fontSizes.body },
});
