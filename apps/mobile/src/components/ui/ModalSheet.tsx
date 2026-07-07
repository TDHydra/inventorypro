import { Modal, Pressable, KeyboardAvoidingView, View, StyleSheet } from 'react-native';
import { colors, radii, spacing } from '../../theme';

export function ModalSheet({ visible, onClose, children }: { visible: boolean; onClose: () => void; children: React.ReactNode }) {
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
        {/* Pressing the sheet itself does NOT close (this Pressable swallows the press). */}
        <Pressable style={s.sheet} onPress={() => {}}>
          {/* Drag-handle pill — standard bottom-sheet affordance */}
          <View style={s.handle} />
          {children}
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
    padding: spacing.xl, maxHeight: '88%',
  },
  handle: {
    width: 40, height: 4, borderRadius: 2,
    backgroundColor: colors.border,
    alignSelf: 'center',
    marginBottom: spacing.md,
  },
});
