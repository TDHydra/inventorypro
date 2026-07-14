import { Modal, Platform, Pressable, KeyboardAvoidingView, ScrollView, View, StyleSheet } from 'react-native';
import { colors, radii, spacing } from '../../theme';

// The app renders edge-to-edge on Android, so the transparent gesture-nav bar
// overlays the bottom of every sheet; without this inset the last row sits
// underneath it and can't be tapped (no safe-area-context module in the dev
// client, so a fixed inset instead of useSafeAreaInsets).
const NAV_BAR_INSET = Platform.OS === 'android' ? 32 : 0;

export function ModalSheet({ visible, onClose, children, scroll = false }: { visible: boolean; onClose: () => void; children: React.ReactNode; scroll?: boolean }) {
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      {/* Full-screen dim backdrop — tapping it closes (onClose only hides; callers keep input state). */}
      <Pressable style={s.backdrop} onPress={onClose} />
      {/* KeyboardAvoidingView lifts the bottom sheet above the keyboard so inputs/text
          aren't cut off. `padding` on BOTH platforms — Android `height` animates the
          container size inside a transparent Modal and produces a jumpy/squished sheet. */}
      <KeyboardAvoidingView
        style={s.kav}
        behavior="padding"
        pointerEvents="box-none"
      >
        {/* Pressing the sheet itself does NOT close (this Pressable swallows the press).
            When scroll is set, the sheet drops its own padding (it moves to the
            ScrollView's contentContainerStyle) so the pill stays pinned and the
            scrollbar isn't clipped. */}
        <Pressable style={scroll ? s.sheetScroll : s.sheet} onPress={() => {}}>
          {/* Drag-handle pill — standard bottom-sheet affordance */}
          <View style={s.handle} />
          {scroll ? (
            // flexShrink:1 is REQUIRED: RN defaults flexShrink:0, so a ScrollView in a
            // height-capped parent measures at full content height and never scrolls.
            <ScrollView
              style={s.scrollView}
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={s.scrollContent}
            >
              {children}
            </ScrollView>
          ) : (
            children
          )}
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
const s = StyleSheet.create({
  backdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(15,23,42,0.45)' },
  // Holds the sheet at the bottom; box-none lets taps in the empty area fall through to the backdrop.
  kav: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    padding: spacing.xl, paddingBottom: spacing.xl + NAV_BAR_INSET, maxHeight: '88%',
  },
  // Scroll variant: same as `sheet` but padding is delegated to scrollContent so the
  // pill and scrollbar aren't double-padded / clipped. paddingTop keeps the pill inset.
  sheetScroll: {
    backgroundColor: colors.surface, borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl,
    paddingTop: spacing.xl, maxHeight: '88%',
  },
  scrollView: { flexShrink: 1 },
  // Padding lives here (NOT flex:1 — that clamps content to the viewport so it never overflows/scrolls).
  scrollContent: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xl + NAV_BAR_INSET },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginBottom: spacing.md,
  },
});
