import { ReactNode } from 'react';
import { View, TextInput, TextInputProps, StyleSheet } from 'react-native';
import { colors, radii, spacing, fontSizes } from '../../theme';

interface Props extends TextInputProps {
  /** Optional trailing adornment (clear button, chevron, …), overlaid on the right edge. */
  right?: ReactNode;
}

export function AppInput({ style, placeholderTextColor, right, ...rest }: Props) {
  const input = (
    <TextInput
      style={[s.input, right != null && s.inputWithRight, style]}
      placeholderTextColor={placeholderTextColor ?? colors.textMuted}
      {...rest}
    />
  );
  if (right == null) return input;
  return (
    <View style={s.wrap}>
      {input}
      <View style={s.right}>{right}</View>
    </View>
  );
}
const s = StyleSheet.create({
  input: {
    backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border,
    paddingHorizontal: spacing.base, height: 44, fontSize: fontSizes.body, color: colors.textPrimary,
  },
  inputWithRight: { paddingRight: 40 },
  wrap: { position: 'relative', justifyContent: 'center' },
  right: { position: 'absolute', right: spacing.sm, height: 44, justifyContent: 'center', alignItems: 'center' },
});
