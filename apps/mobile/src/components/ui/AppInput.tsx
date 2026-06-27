import { TextInput, TextInputProps, StyleSheet } from 'react-native';
import { colors, radii, spacing, fontSizes } from '../../theme';

export function AppInput({ style, placeholderTextColor, ...rest }: TextInputProps) {
  return <TextInput style={[s.input, style]} placeholderTextColor={placeholderTextColor ?? colors.textMuted} {...rest} />;
}
const s = StyleSheet.create({
  input: {
    backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.base, height: 44, fontSize: fontSizes.body, color: colors.textPrimary,
  },
});
