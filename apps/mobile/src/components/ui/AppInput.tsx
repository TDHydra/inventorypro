import { useState } from 'react';
import { TextInput, TextInputProps, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';

const makeStyles = (t: Theme) => {
  const { height, borderWidth } = t.components.input;
  const base = {
    height,
    paddingHorizontal: t.spacing.base,
    fontSize: t.typography.fontSizes.body,
    color: t.colors.inputText,
    ...(t.typography.fontFamily.regular ? { fontFamily: t.typography.fontFamily.regular } : {}),
  };
  return StyleSheet.create({
    outlined: {
      ...base,
      backgroundColor: t.colors.inputBg, borderRadius: t.radii.input,
      borderWidth, borderColor: t.colors.inputBorder,
    },
    filled: {
      ...base,
      backgroundColor: t.colors.inputBg, borderRadius: t.radii.input, borderWidth: 0,
    },
    // 2px focus ring; padding compensates so text doesn't shift on focus.
    filledFocused: {
      ...base,
      paddingHorizontal: t.spacing.base - 2,
      backgroundColor: t.colors.surfaceAlt, borderRadius: t.radii.input,
      borderWidth: 2, borderColor: t.colors.primary,
    },
    underlined: {
      ...base,
      backgroundColor: 'transparent', borderRadius: 0,
      borderBottomWidth: Math.max(borderWidth, 1), borderBottomColor: t.colors.inputBorder,
    },
  });
};

export function AppInput({ style, placeholderTextColor, onFocus, onBlur, ...rest }: TextInputProps) {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const { variant } = t.components.input;
  const variantStyle =
    variant === 'filled' ? (focused ? s.filledFocused : s.filled)
    : variant === 'underlined' ? s.underlined
    : s.outlined;
  return (
    <TextInput
      style={[variantStyle, style]}
      placeholderTextColor={placeholderTextColor ?? t.colors.placeholder}
      onFocus={(e) => { setFocused(true); onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); onBlur?.(e); }}
      {...rest}
    />
  );
}
