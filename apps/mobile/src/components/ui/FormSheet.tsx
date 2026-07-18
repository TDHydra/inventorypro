import { ReactNode } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { ModalSheet } from './ModalSheet';
import { FormActions } from './FormActions';
import { confirmDestructive } from '../../lib/confirm';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

/**
 * The standard create/edit popup scaffold: title bar + close, scrollable
 * body, sticky action footer, and a dirty-state discard guard. Generalizes
 * what `QuickCreateSheet`, `EntityEditSheet` and `RequestApprovalSheet` each
 * hand-roll on top of `ModalSheet`.
 *
 * Usage:
 * ```tsx
 * const [name, setName] = useState('');
 * const [busy, setBusy] = useState(false);
 *
 * async function submit() {
 *   setBusy(true);
 *   try {
 *     await createThing({ name });
 *     onClose();
 *   } finally {
 *     setBusy(false);
 *   }
 * }
 *
 * <FormSheet
 *   visible={visible}
 *   onClose={onClose}
 *   title="New thing"
 *   dirty={name.length > 0}
 *   busy={busy}
 *   onSubmit={submit}
 * >
 *   <TextField label="Name" value={name} onChangeText={setName} />
 * </FormSheet>
 * ```
 */

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  onSubmit?: () => void | Promise<void>;
  submitLabel?: string;
  submitDisabled?: boolean;
  /** When true, closing (✕, backdrop, or Android back) confirms discard first. */
  dirty?: boolean;
  /** Whether the body scrolls. Default true. */
  scroll?: boolean;
  /** Disables submit + close and shows a spinner in the submit button. */
  busy?: boolean;
}

export function FormSheet({
  visible,
  onClose,
  title,
  children,
  onSubmit,
  submitLabel = 'Save',
  submitDisabled,
  dirty,
  scroll = true,
  busy,
}: Props) {
  const s = useThemedStyles(makeStyles);
  function requestClose() {
    if (busy) return;
    if (dirty) {
      confirmDestructive({
        title: 'Discard changes?',
        message: 'You have unsaved changes that will be lost.',
        confirmLabel: 'Discard',
        onConfirm: onClose,
      });
      return;
    }
    onClose();
  }

  function handleSubmit() {
    if (busy || submitDisabled || !onSubmit) return;
    void onSubmit();
  }

  return (
    // scroll is handled internally (below) so the footer can stay sticky —
    // ModalSheet's own `scroll` prop would wrap the footer into the scroll area too.
    <ModalSheet visible={visible} onClose={requestClose}>
      <View style={s.header}>
        <Text style={s.title} numberOfLines={1}>{title}</Text>
        <Pressable onPress={requestClose} disabled={busy} hitSlop={8} style={busy && s.closeDisabled}>
          <Text style={s.close}>✕</Text>
        </Pressable>
      </View>
      {scroll ? (
        // flexShrink:1 mirrors the trick ModalSheet uses internally: the sheet
        // container is height-capped (maxHeight) but not itself flex:1, so a
        // ScrollView child needs flexShrink:1 or it measures full content
        // height and never actually scrolls — see ModalSheet.tsx.
        <ScrollView style={s.scrollBody} keyboardShouldPersistTaps="handled" contentContainerStyle={s.scrollContent}>
          {children}
        </ScrollView>
      ) : (
        <View style={s.body}>{children}</View>
      )}
      {/* FormActions' PrimaryButton already renders an inline ActivityIndicator
          when `busy` is passed through as its `loading` prop. */}
      <FormActions
        onCancel={requestClose}
        onSave={handleSubmit}
        saveLabel={submitLabel}
        busy={busy}
        disabled={submitDisabled}
      />
    </ModalSheet>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: t.spacing.md,
  },
  title: { flex: 1, fontSize: t.typography.fontSizes.lg, fontWeight: '700', color: t.colors.textPrimary, marginRight: t.spacing.md },
  close: { fontSize: t.typography.fontSizes.lg, color: t.colors.textSecondary },
  closeDisabled: { opacity: 0.4 },
  body: { flexShrink: 1 },
  scrollBody: { flexShrink: 1 },
  scrollContent: { flexGrow: 1 },
});
