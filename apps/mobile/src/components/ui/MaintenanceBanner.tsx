import { Text, StyleSheet } from 'react-native';
import { colors, spacing, fontSizes } from '../../theme';

export function MaintenanceBanner() {
  return <Text style={s.text}>Read-only during maintenance</Text>;
}
const s = StyleSheet.create({
  text: { color: colors.warning, marginTop: spacing.sm, fontSize: fontSizes.body2, fontWeight: '600' },
});
