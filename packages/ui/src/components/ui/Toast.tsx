import { Text, View, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  message: string;
  tone?: 'success' | 'danger' | 'primary';
}

/**
 * Inline banner toast — extracted from QuickAddScreenShell's green "Added"
 * banner so every screen shares one themed seam. Render-when-present (the
 * caller owns visibility/timeout state, same as the QuickAdd pattern).
 */
export function Toast({ message, tone = 'success' }: Props) {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);
  const bg = tone === 'danger' ? t.colors.danger : tone === 'primary' ? t.colors.primary : t.colors.success;
  return (
    <View style={[s.toast, { backgroundColor: bg }]}>
      <Text style={s.text}>{message}</Text>
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  toast: { paddingHorizontal: t.spacing.lg, paddingVertical: 10, alignItems: 'center' },
  text: {
    color: t.colors.onPrimary,
    fontWeight: t.typography.weights.bold,
    fontSize: t.typography.fontSizes.body,
    fontFamily: t.typography.fontFamily.medium,
  },
});
