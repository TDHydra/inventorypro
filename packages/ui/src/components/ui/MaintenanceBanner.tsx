import { Text, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

export function MaintenanceBanner() {
  const s = useThemedStyles(makeStyles);
  return <Text style={s.text}>Read-only during maintenance</Text>;
}
const makeStyles = (t: Theme) => StyleSheet.create({
  text: { color: t.colors.warning, marginTop: t.spacing.sm, fontSize: t.typography.fontSizes.body2, fontWeight: '600' },
});
