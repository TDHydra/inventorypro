import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { formScreenBottomPadding } from '../../formScreenInsets';
import type { FormScreenProps } from './FormScreen.types';

/**
 * FormScreen — web fallback (#118). react-native-keyboard-controller is
 * native-only, so on web we render a plain ScrollView and never import/evaluate
 * the native module. Browsers reflow around their own soft keyboards, so no
 * keyboard-aware scrolling is needed; the optional `footer` is pinned below the
 * scroll area (no KeyboardStickyView). Props mirror the native FormScreen so
 * callers are platform-agnostic; `bottomOffset` is accepted and ignored here.
 */
export function FormScreen({
  children,
  contentContainerStyle,
  footer,
  scrollRef,
  keyboardShouldPersistTaps = 'handled',
  bottomOffset: _bottomOffset,
  style,
  testID,
  ...rest
}: FormScreenProps) {
  const s = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  const flatContent = StyleSheet.flatten([s.content, contentContainerStyle]);
  const baseBottom =
    typeof flatContent.paddingBottom === 'number'
      ? flatContent.paddingBottom
      : typeof flatContent.padding === 'number'
        ? flatContent.padding
        : 0;

  return (
    <View style={[s.container, style]} testID={testID}>
      <ScrollView
        ref={scrollRef}
        style={s.scroll}
        contentContainerStyle={[
          flatContent,
          { paddingBottom: formScreenBottomPadding(baseBottom, insets.bottom) },
        ]}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        {...rest}
      >
        {children}
      </ScrollView>
      {footer != null && <View>{footer}</View>}
    </View>
  );
}

const makeStyles = (t: Theme) =>
  StyleSheet.create({
    container: { flex: 1, backgroundColor: t.colors.background },
    scroll: { flex: 1 },
    content: { padding: t.spacing.lg, paddingBottom: t.spacing.xxxl },
  });
