import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { PrimaryButton } from './PrimaryButton';
import type { Theme } from '../../themes/types';
import { useThemedStyles } from '../../hooks/useThemedStyles';

interface Props {
  onCancel: () => void;
  onSave: () => void;
  saveLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  disabled?: boolean;
}

/**
 * The Cancel + Save button row every edit form hand-rolls, extracted once.
 * Styles are copied verbatim from (jobs)/[id].tsx (s.row / s.btnGhost) so a
 * swap is visually identical. Pure — no persistence, no alerts.
 */
export function FormActions({ onCancel, onSave, saveLabel = 'Save', cancelLabel = 'Cancel', busy, disabled }: Props) {
  const s = useThemedStyles(makeStyles);
  return (
    <View style={s.row}>
      <TouchableOpacity style={[s.btnGhost, { flex: 1 }]} onPress={onCancel} disabled={busy}>
        <Text style={s.btnGhostText}>{cancelLabel}</Text>
      </TouchableOpacity>
      <PrimaryButton label={saveLabel} onPress={onSave} loading={busy} disabled={disabled} style={{ flex: 1 }} />
    </View>
  );
}

const makeStyles = (t: Theme) => StyleSheet.create({
  row: { flexDirection: 'row', gap: t.spacing.md, marginTop: t.spacing.lg },
  btnGhost: {
    borderRadius: t.radii.button, paddingVertical: 13, alignItems: 'center',
    backgroundColor: t.colors.surface, borderWidth: 1, borderColor: t.colors.textDisabled,
  },
  btnGhostText: {
    color: t.colors.textStrong,
    fontWeight: t.typography.weights.semibold,
    fontSize: t.typography.fontSizes.base,
    fontFamily: t.typography.fontFamily.medium,
    letterSpacing: t.typography.letterSpacing,
    textTransform: t.components.button.textTransform,
  },
});
