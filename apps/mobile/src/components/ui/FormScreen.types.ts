import type { ReactNode, Ref } from 'react';
import type { ScrollView, ScrollViewProps, StyleProp, ViewStyle } from 'react-native';

/**
 * Shared prop contract for FormScreen (#118). Types-only module (erased at
 * compile time) so both the native (FormScreen.tsx) and web (FormScreen.web.tsx)
 * implementations stay in lockstep without either pulling in the other's runtime.
 *
 * Extends ScrollViewProps so any remaining scroll props (refreshControl,
 * onScroll, showsVerticalScrollIndicator, …) forward through to the underlying
 * scroll view on both platforms.
 */
export interface FormScreenProps
  extends Omit<
    ScrollViewProps,
    'children' | 'contentContainerStyle' | 'style' | 'keyboardShouldPersistTaps' | 'ref'
  > {
  children: ReactNode;
  /** Extra styles merged onto the themed scroll content container. A numeric
   *  paddingBottom here is treated as the BASE bottom padding — the safe-area
   *  inset is added on top of it (see formScreenBottomPadding). */
  contentContainerStyle?: StyleProp<ViewStyle>;
  /** Optional sticky action/save bar. Native: floats above the keyboard via
   *  KeyboardStickyView. Web: pinned below the scroll area. Absent by default,
   *  so existing screens are forced into nothing. */
  footer?: ReactNode;
  /** Ref to the underlying scroll view (native: KeyboardAwareScrollView). */
  scrollRef?: Ref<ScrollView>;
  /** Defaults to 'handled' so tapping a picker/dropdown option while the
   *  keyboard is open does not dismiss it first. */
  keyboardShouldPersistTaps?: ScrollViewProps['keyboardShouldPersistTaps'];
  /** Override the theme's KeyboardAwareScrollView `bottomOffset` (native only;
   *  ignored on web). Defaults to theme.keyboard.focusExtraOffset. */
  bottomOffset?: number;
  /** Extra styles merged onto the themed outer container (flex + background). */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}
