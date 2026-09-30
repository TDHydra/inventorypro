import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';
import { PrimaryButton } from '../ui/PrimaryButton';
import { MaintenanceBanner } from '../ui/MaintenanceBanner';

/**
 * The shared "Save & add another" / "Done" action bar every quick-add form
 * passes to FormScreen's `footer` slot (#118). Rendering it as a FormScreen
 * footer (instead of the last children of the scroll content, where it used to
 * live) keeps it pinned above the keyboard via KeyboardStickyView — the shell
 * folds its measured height into `bottomOffset` so focused fields clear it.
 * Styling mirrors the checkout qty step's footer bar (the original adopter).
 */
export function QuickAddFooter({
  onSave,
  saveLabel = 'Save & add another',
  disabled,
  loading,
  locked,
  showDone = true,
  error,
}: {
  onSave: () => void;
  saveLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  /** Maintenance lock — shows the read-only banner under the save button. */
  locked: boolean;
  /** Job/Repair quick-adds historically had no Done row — they opt out. */
  showDone?: boolean;
  /** Form-level error pinned above the save button so it's visible even while
   *  the keyboard is open (field-level errors stay inline with their fields). */
  error?: string;
}) {
  const s = useThemedStyles(makeStyles);
  const router = useRouter();

  return (
    <View style={s.bar}>
      {!!error && <Text style={s.errorText}>{error}</Text>}
      <PrimaryButton label={saveLabel} onPress={onSave} disabled={disabled} loading={loading} />
      {locked && <MaintenanceBanner />}
      {showDone && (
        <TouchableOpacity style={s.doneBtn} onPress={() => router.back()}>
          <Text style={s.doneBtnText}>Done</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  bar: {
    padding: t.spacing.lg,
    backgroundColor: t.colors.background,
    borderTopWidth: 1,
    borderTopColor: t.colors.border,
    gap: t.spacing.sm,
  },
  errorText: { fontSize: t.typography.fontSizes.caption, color: t.colors.danger },
  doneBtn: { alignItems: 'center', paddingVertical: t.spacing.xs },
  doneBtnText: { color: t.colors.textSecondary, fontSize: t.typography.fontSizes.md, fontWeight: '600' },
});
