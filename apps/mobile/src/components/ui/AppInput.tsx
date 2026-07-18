import { ReactNode, useState } from 'react';
import { View, TextInput, TextInputProps, StyleSheet } from 'react-native';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props extends TextInputProps {
  /** Optional trailing adornment (clear button, chevron, …), overlaid on the right edge. */
  right?: ReactNode;
}

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
    inputWithRight: { paddingRight: 40 },
    wrap: { position: 'relative', justifyContent: 'center' },
    right: { position: 'absolute', right: t.spacing.sm, height, justifyContent: 'center', alignItems: 'center' },
  });
};

export function AppInput({ style, placeholderTextColor, onFocus, onBlur, right, ...rest }: Props) {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);
  const [focused, setFocused] = useState(false);
  const { variant } = t.components.input;
  const variantStyle =
    variant === 'filled' ? (focused ? s.filledFocused : s.filled)
    : variant === 'underlined' ? s.underlined
    : s.outlined;
  const input = (
    <TextInput
      style={[variantStyle, right != null && s.inputWithRight, style]}
      placeholderTextColor={placeholderTextColor ?? t.colors.placeholder}
      onFocus={(e) => { setFocused(true); onFocus?.(e); }}
      onBlur={(e) => { setFocused(false); onBlur?.(e); }}
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
