import { useState, type ComponentProps } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import {
  KeyboardAwareScrollView,
  KeyboardStickyView,
} from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '../../themes/types';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { formScreenBottomPadding } from '../../formScreenInsets';
import type { FormScreenProps } from './FormScreen.types';

/**
 * FormScreen (#118) — the single shell every form screen uses instead of a
 * hand-rolled KeyboardAvoidingView + ScrollView.
 *
 * Native path (this file): renders keyboard-controller's KeyboardAwareScrollView,
 * which natively scrolls the *focused* field into view above the keyboard (the
 * "fluid" behavior the issue asks for), keeping `keyboardShouldPersistTaps` and
 * a themed background + content padding. The optional `footer` floats above the
 * keyboard via KeyboardStickyView. The web build resolves FormScreen.web.tsx
 * instead (plain ScrollView; keyboard-controller is native-only).
 *
 * Content bottom padding = the base bottom padding (from contentContainerStyle,
 * else the themed default) PLUS the device safe-area bottom inset, via
 * formScreenBottomPadding — so the last field / non-sticky button clears the
 * gesture nav bar. (SafeAreaProvider is installed in app/_layout.tsx; without it
 * useSafeAreaInsets() returns 0 and this is a no-op.)
 */
export function FormScreen({
  children,
  contentContainerStyle,
  footer,
  scrollRef,
  keyboardShouldPersistTaps = 'handled',
  bottomOffset,
  style,
  testID,
  ...rest
}: FormScreenProps) {
  const t = useTheme();
  const s = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  // A sticky footer (KeyboardStickyView) floats above the keyboard, occupying
  // its own height between the keyboard top and the content. Fold that height
  // into bottomOffset so the *focused* field clears the footer instead of
  // hiding behind it (#118 would otherwise regress on footer screens). Measured
  // rather than hard-coded so any footer height stays correct.
  const [footerHeight, setFooterHeight] = useState(0);
  const onFooterLayout = (e: LayoutChangeEvent) =>
    setFooterHeight(e.nativeEvent.layout.height);
  const effectiveBottomOffset =
    (bottomOffset ?? t.keyboard.focusExtraOffset) + (footer != null ? footerHeight : 0);

  // Take the base bottom padding from whatever the caller (or the themed default)
  // specifies, then add the safe-area inset on top of it.
  const flatContent = StyleSheet.flatten([s.content, contentContainerStyle]);
  const baseBottom =
    typeof flatContent.paddingBottom === 'number'
      ? flatContent.paddingBottom
      : typeof flatContent.padding === 'number'
        ? flatContent.padding
        : 0;

  return (
    <View style={[s.container, style]} testID={testID}>
      <KeyboardAwareScrollView
        // Cross-platform prop types scrollRef as an RN ScrollView ref (what the
        // web fallback and most callers use); the native component augments that
        // with assureFocusedInputVisible, so bridge the two ref types here.
        ref={scrollRef as unknown as ComponentProps<typeof KeyboardAwareScrollView>['ref']}
        style={s.scroll}
        contentContainerStyle={[
          flatContent,
          { paddingBottom: formScreenBottomPadding(baseBottom, insets.bottom) },
        ]}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        bottomOffset={effectiveBottomOffset}
        {...rest}
      >
        {children}
      </KeyboardAwareScrollView>
      {footer != null && (
        <KeyboardStickyView onLayout={onFooterLayout}>{footer}</KeyboardStickyView>
      )}
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: t.colors.background },
    scroll: { flex: 1 },
    // Sensible themed default used only when a screen passes no
    // contentContainerStyle; migrated screens supply their own.
    content: { padding: t.spacing.lg, paddingBottom: t.spacing.xxxl },
  });
