import { useEffect, useRef, useState } from 'react';
import { Animated, Modal, Platform, Pressable, KeyboardAvoidingView, ScrollView, View, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '../../themes/types';
import { sheetAnimations } from '../../themes/motionPresets';
import { useTheme } from '../../hooks/useTheme';
import { useThemedStyles } from '../../hooks/useThemedStyles';

// Web twin of ModalSheet — keep render trees in sync. #187: bottom padding
// uses the runtime safe-area inset (0 on web, so the floor is what matters
// on Android; harmless here but the trees must match).
const NAV_BAR_INSET_FLOOR = Platform.OS === 'android' ? 32 : 0;
// Off-screen start for the driver-based presentations — taller than any sheet
// (maxHeight caps well under a full viewport) so enter always starts fully hidden.
const SHEET_TRAVEL = 600;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// scroll defaults ON (#187 follow-up): a sheet with no scroll surface silently
// clips overflow at maxHeight, stranding form tails and option rows off-screen.
// Pass scroll={false} ONLY when the sheet owns its scroll surface (FormSheet's
// keyboard-aware scroller, sheets with an inner ScrollView or virtualized list)
// — nesting two vertical scrollers makes Android pan negotiation flaky.
export function ModalSheet({ visible, onClose, children, scroll = true }: { visible: boolean; onClose: () => void; children: React.ReactNode; scroll?: boolean }) {
  const theme = useTheme();
  const s = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  // #187: nav-bar clearance for the sheet's bottom edge (see native twin).
  const navInset = Math.max(insets.bottom, NAV_BAR_INSET_FLOOR);
  const { presentation, showHandle } = theme.components.sheet;
  const centered = presentation === 'center-dialog';
  // Driver-based presentations use animationType="none" and animate the sheet themselves.
  const animated = presentation === 'slide-fast' || presentation === 'spring-bottom';

  // Kept mounted through the exit animation so the sheet can slide out before the Modal hides.
  const [mounted, setMounted] = useState(visible);
  const driver = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!animated) return;
    const preset = sheetAnimations[presentation];
    if (visible) {
      setMounted(true);
      const anim = preset.enter(driver, theme);
      anim.start();
      return () => anim.stop();
    }
    const anim = preset.exit(driver, theme);
    anim.start(({ finished }) => { if (finished) setMounted(false); });
    return () => anim.stop();
  }, [visible, animated, presentation, theme, driver]);

  const modalVisible = animated ? visible || mounted : visible;
  // 'clamp' also caps spring overshoot (driver > 1) — otherwise the sheet would
  // translate above its resting position and lift its bottom edge off the nav inset.
  const translateY = driver.interpolate({ inputRange: [0, 1], outputRange: [SHEET_TRAVEL, 0], extrapolate: 'clamp' });
  const backdropOpacity = driver.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' });

  const sheetStyle = centered ? (scroll ? s.dialogScroll : s.dialog) : scroll ? s.sheetScroll : s.sheet;

  return (
    <Modal
      visible={modalVisible}
      animationType={centered ? 'fade' : animated ? 'none' : 'slide'}
      transparent
      onRequestClose={onClose}
    >
      {/* Full-screen dim backdrop — tapping it closes (onClose only hides; callers keep input state). */}
      {animated ? (
        <AnimatedPressable style={[s.backdrop, { opacity: backdropOpacity }]} onPress={onClose} />
      ) : (
        <Pressable style={s.backdrop} onPress={onClose} />
      )}
      {/* KeyboardAvoidingView lifts the sheet above the keyboard so inputs/text
          aren't cut off. `padding` on BOTH platforms — Android `height` animates the
          container size inside a transparent Modal and produces a jumpy/squished sheet.
          Centered dialogs keep `padding` too: the shrunken container re-centers the card. */}
      <KeyboardAvoidingView
        style={centered ? s.kavCenter : s.kav}
        behavior="padding"
        pointerEvents="box-none"
      >
        {/* Plain View, NOT a Pressable (#187): a pressable sheet claims the JS
            responder for touches on non-touchable children (Text/Image), and RN
            then blocks the inner ScrollView's native drag interception — swipes
            over text or images couldn't scroll. Taps on the sheet body still
            can't reach the backdrop: it's a sibling, not an ancestor, and RN
            targets touches to the topmost subtree (no DOM-style fall-through).
            When scroll is set, the sheet drops its own padding (it moves to the
            ScrollView's contentContainerStyle) so the pill stays pinned and the
            scrollbar isn't clipped. */}
        <Animated.View
          style={[
            sheetStyle,
            // Bottom sheets rest on the screen edge, so their own bottom padding
            // (or, in scroll mode, the content's) must clear the nav bar.
            !centered && !scroll && { paddingBottom: theme.spacing.xl + navInset },
            animated && { transform: [{ translateY }] },
          ]}
        >
          {/* Drag-handle pill — standard bottom-sheet affordance; never shown on centered dialogs */}
          {!centered && showHandle ? <View style={s.handle} /> : null}
          {scroll ? (
            // flexShrink:1 is REQUIRED: RN defaults flexShrink:0, so a ScrollView in a
            // height-capped parent measures at full content height and never scrolls.
            <ScrollView
              style={s.scrollView}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={
                centered
                  ? s.scrollContentDialog
                  : [s.scrollContent, { paddingBottom: theme.spacing.xl + navInset }]
              }
            >
              {children}
            </ScrollView>
          ) : (
            children
          )}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
const makeStyles = (t: Theme) => {
  const { topRadius, maxHeightPct } = t.components.sheet;
  const maxHeight = `${maxHeightPct}%` as const;
  return StyleSheet.create({
    backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.colors.backdrop },
    // Holds the sheet at the bottom; box-none lets taps in the empty area fall through to the backdrop.
    kav: { flex: 1, justifyContent: 'flex-end' },
    kavCenter: { flex: 1, justifyContent: 'center' },
    sheet: {
      backgroundColor: t.colors.surface, borderTopLeftRadius: topRadius, borderTopRightRadius: topRadius,
      // Bottom padding is overridden inline with the runtime safe-area inset (#187).
      padding: t.spacing.xl, maxHeight,
    },
    // Scroll variant: same as `sheet` but padding is delegated to scrollContent so the
    // pill and scrollbar aren't double-padded / clipped. paddingTop keeps the pill inset.
    sheetScroll: {
      backgroundColor: t.colors.surface, borderTopLeftRadius: topRadius, borderTopRightRadius: topRadius,
      paddingTop: t.spacing.xl, maxHeight,
    },
    // Centered card: bordered, inset horizontally; NAV_BAR_INSET doesn't apply off the bottom edge.
    dialog: {
      backgroundColor: t.colors.surface, borderRadius: t.radii.sheet,
      borderWidth: 1, borderColor: t.colors.border,
      alignSelf: 'stretch', marginHorizontal: t.spacing.xl,
      padding: t.spacing.xl, maxHeight,
    },
    dialogScroll: {
      backgroundColor: t.colors.surface, borderRadius: t.radii.sheet,
      borderWidth: 1, borderColor: t.colors.border,
      alignSelf: 'stretch', marginHorizontal: t.spacing.xl,
      paddingTop: t.spacing.xl, maxHeight,
    },
    scrollView: { flexShrink: 1 },
    // Padding lives here (NOT flex:1 — that clamps content to the viewport so it never
    // overflows/scrolls). Bottom padding is overridden inline with the runtime inset (#187).
    scrollContent: { paddingHorizontal: t.spacing.xl },
    scrollContentDialog: { paddingHorizontal: t.spacing.xl, paddingBottom: t.spacing.xl },
    handle: {
      width: 40, height: 4, borderRadius: 2,
      backgroundColor: t.colors.border,
      alignSelf: 'center',
      marginBottom: t.spacing.md,
    },
  });
};
