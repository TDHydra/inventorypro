import { Text, StyleSheet } from 'react-native';
import { colors, fontSizes } from '../../theme';

export function FieldLabel({ children, style }: { children: string; style?: object }) {
  return <Text style={[s.label, style]}>{children}</Text>;
}
const s = StyleSheet.create({
  label: { fontSize: fontSizes.caption, fontWeight: '700', color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.5 },
});
